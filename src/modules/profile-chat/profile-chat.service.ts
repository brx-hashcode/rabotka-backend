import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApplicationStatus,
  ContactUnlockStatus,
  MessageModerationStatus,
  Prisma,
  type ProfileConversation,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { ModerationService } from './moderation/moderation.service';
import type { RedactionCategory } from './moderation/patterns';

const ENABLED_KEY = 'messaging.enabled';
const MODERATE_AFTER_UNLOCK_KEY = 'messaging.moderate_after_unlock';

/** A withheld fragment, as the SENDER sees it. Never sent to anybody else. */
export interface RedactionView {
  start: number;
  end: number;
  category: RedactionCategory;
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  mine: boolean;
  /** Original for the author, redacted for the recipient. Built server-side. */
  body: string;
  status: MessageModerationStatus;
  /** Populated for the author only, so they can see WHICH characters stayed behind. */
  redactions: RedactionView[];
  createdAt: Date;
  readAt: Date | null;
}

export interface ConversationView {
  id: string;
  counterpartId: string;
  counterpartName: string;
  jobTitle: string | null;
  applicationId: string | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  closed: boolean;
  contactsUnlocked: boolean;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Statuses in which a conversation may still be opened or written to.
 *
 * A dead application gets a read-only thread rather than a deleted one: it is
 * evidence for whatever claim follows. WAITING_PAYMENT is very much alive —
 * that is precisely the moment the two need to talk.
 */
const LIVE_APPLICATION_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  ApplicationStatus.PENDING,
  ApplicationStatus.VIEWED,
  ApplicationStatus.WAITING_PAYMENT,
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.STARTED,
]);

@Injectable()
export class ProfileChatService {
  private readonly logger = new Logger(ProfileChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: SystemConfigService,
    private readonly moderation: ModerationService,
  ) {}

  // ── Conversations ──────────────────────────────────────────────────────────

  /**
   * Opens the conversation for an application, or returns the existing one.
   *
   * LAZY, and that is a cost decision rather than a style one: an offer with 60
   * applicants of whom 3 ever write would otherwise put 60 empty threads in
   * everyone's list. The row appears on the first message.
   *
   * Idempotent without a lock. Two simultaneous first messages both try to
   * insert; the unique index on `application_id` rejects one, and that one
   * re-reads instead of failing. Catching P2002 is the whole concurrency story
   * here — see the note in the catch.
   */
  async openForApplication(
    applicationId: string,
    actorId: string,
  ): Promise<ProfileConversation> {
    const application = await this.prisma.application.findFirst({
      where: { id: applicationId, deleted_at: null },
      select: {
        id: true,
        worker_id: true,
        status: true,
        job_offer: { select: { employer_id: true } },
      },
    });
    if (!application) throw new NotFoundException('Candidature introuvable');

    const workerId = application.worker_id;
    const employerId = application.job_offer.employer_id;
    if (actorId !== workerId && actorId !== employerId) {
      throw new ForbiddenException('Cette candidature ne vous concerne pas');
    }
    if (!LIVE_APPLICATION_STATUSES.has(application.status)) {
      throw new BadRequestException(
        'Cette candidature est terminée, la discussion est close',
      );
    }

    const existing = await this.prisma.profileConversation.findUnique({
      where: { application_id: applicationId },
    });
    if (existing) return existing;

    try {
      return await this.prisma.profileConversation.create({
        data: {
          worker_id: workerId,
          employer_id: employerId,
          application_id: applicationId,
        },
      });
    } catch (error) {
      // P2002 means the other party's first message won the race by
      // microseconds. That is a success from here: re-read and carry on. Any
      // other error is a real failure and must not be swallowed.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.profileConversation.findUnique({
          where: { application_id: applicationId },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  async listConversations(
    profileId: string,
    page = 1,
    limit = 20,
  ): Promise<Paginated<ConversationView>> {
    const where: Prisma.ProfileConversationWhereInput = {
      OR: [{ worker_id: profileId }, { employer_id: profileId }],
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.profileConversation.count({ where }),
      this.prisma.profileConversation.findMany({
        where,
        orderBy: [{ last_message_at: 'desc' }, { created_at: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          worker: { select: { id: true, first_name: true, last_name: true } },
          employer: { select: { id: true, first_name: true, last_name: true } },
          application: {
            select: {
              id: true,
              job_offer: { select: { title: true } },
              contact_unlock_attempt: { select: { status: true } },
            },
          },
          messages: {
            where: { deleted_at: null },
            orderBy: { created_at: 'desc' },
            take: 1,
            select: {
              body: true,
              sender_id: true,
              moderation_status: true,
              redactions: {
                select: { start_offset: true, end_offset: true, category: true },
              },
            },
          },
        },
      }),
    ]);

    // One grouped count rather than a query per row: a list of 20 conversations
    // would otherwise be 21 round trips.
    const unread = await this.unreadCounts(
      profileId,
      rows.map((r) => r.id),
    );

    return {
      data: rows.map((row) => {
        const isWorker = row.worker_id === profileId;
        const counterpart = isWorker ? row.employer : row.worker;
        const last = row.messages[0];

        return {
          id: row.id,
          counterpartId: counterpart.id,
          counterpartName: `${counterpart.first_name} ${counterpart.last_name}`,
          jobTitle: row.application?.job_offer.title ?? null,
          applicationId: row.application_id,
          lastMessageAt: row.last_message_at,
          // The preview obeys the same rule as the thread: if the last message
          // was not this profile's, they get the redacted form. A preview is a
          // message too, and a leak in a list is still a leak.
          lastMessagePreview: last
            ? this.bodyFor(
                {
                  body: last.body,
                  sender_id: last.sender_id,
                  moderation_status: last.moderation_status,
                  redactions: last.redactions,
                },
                profileId,
              )
            : null,
          unreadCount: unread.get(row.id) ?? 0,
          closed: row.closed_at !== null,
          contactsUnlocked:
            row.application?.contact_unlock_attempt?.status ===
            ContactUnlockStatus.UNLOCKED,
        };
      }),
      total,
      page,
      limit,
    };
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  async listMessages(
    conversationId: string,
    profileId: string,
    page = 1,
    limit = 50,
  ): Promise<Paginated<MessageView>> {
    await this.requireParticipant(conversationId, profileId);

    // A HELD message was never delivered, so it does not exist for the
    // recipient — but the author must still see it, marked as not delivered,
    // or their own message simply vanishes with no explanation.
    const visible: Prisma.ProfileMessageWhereInput = {
      conversation_id: conversationId,
      deleted_at: null,
      OR: [
        { sender_id: profileId },
        { moderation_status: { not: MessageModerationStatus.HELD } },
      ],
    };

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.profileMessage.count({ where: visible }),
      this.prisma.profileMessage.findMany({
        where: visible,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          redactions: {
            select: { start_offset: true, end_offset: true, category: true },
            orderBy: { start_offset: 'asc' },
          },
        },
      }),
    ]);

    return {
      data: rows.map((row) => this.toMessageView(row, profileId)),
      total,
      page,
      limit,
    };
  }

  /**
   * Moderates and stores one message, and returns the AUTHOR's view of it.
   *
   * The two sides of the response are built here, not in the controller and
   * certainly not in the client: the author gets the original plus the offsets
   * of what was withheld, the recipient gets the redacted body and no offsets
   * at all. Redacting in the client would leave the real number in the response
   * body, one network tab away, and the whole feature would be decoration.
   */
  async sendMessage(
    conversationId: string,
    senderId: string,
    body: string,
  ): Promise<MessageView> {
    if (!(await this.isEnabled())) {
      throw new BadRequestException(
        'La messagerie est momentanément indisponible',
      );
    }

    const conversation = await this.requireParticipant(
      conversationId,
      senderId,
    );
    if (conversation.closed_at) {
      throw new BadRequestException('Cette discussion est close');
    }

    const verdict = await this.moderation.review(
      body,
      await this.shouldModerate(conversation),
    );

    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.profileMessage.create({
        data: {
          conversation_id: conversationId,
          sender_id: senderId,
          body,
          moderation_status: verdict.status,
          redactions: {
            create: verdict.spans.map((span) => ({
              start_offset: span.start,
              end_offset: span.end,
              category: span.category,
              matched_by: span.matchedBy,
            })),
          },
        },
        include: {
          redactions: {
            select: { start_offset: true, end_offset: true, category: true },
            orderBy: { start_offset: 'asc' },
          },
        },
      });

      // A held message never reached anybody, so it must not bump the thread to
      // the top of the recipient's list — that would be a notification for
      // something they cannot read.
      if (verdict.status !== MessageModerationStatus.HELD) {
        await tx.profileConversation.update({
          where: { id: conversationId },
          data: { last_message_at: created.created_at },
        });
      }

      return created;
    });

    return this.toMessageView(message, senderId);
  }

  /** What the OTHER party should be pushed and notified with, or null if nothing. */
  deliverableFor(message: MessageView, recipientId: string): MessageView | null {
    if (message.status === MessageModerationStatus.HELD) return null;
    return { ...message, mine: false, redactions: [], senderId: message.senderId };
  }

  async markRead(conversationId: string, profileId: string): Promise<number> {
    const conversation = await this.requireParticipant(
      conversationId,
      profileId,
    );
    const now = new Date();

    const { count } = await this.prisma.profileMessage.updateMany({
      where: {
        conversation_id: conversationId,
        sender_id: { not: profileId },
        read_at: null,
        deleted_at: null,
        moderation_status: { not: MessageModerationStatus.HELD },
      },
      data: { read_at: now },
    });

    await this.prisma.profileConversation.update({
      where: { id: conversation.id },
      data:
        conversation.worker_id === profileId
          ? { worker_last_read_at: now }
          : { employer_last_read_at: now },
    });

    return count;
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  /**
   * "This was not a phone number."
   *
   * Only the AUTHOR may report, because only they know what they meant. It is
   * also the only role for whom the claim is falsifiable: the recipient never
   * saw the withheld text.
   */
  async reportRedaction(
    messageId: string,
    reporterId: string,
    note?: string,
  ): Promise<void> {
    const message = await this.prisma.profileMessage.findFirst({
      where: { id: messageId, deleted_at: null },
      select: { id: true, sender_id: true, moderation_status: true },
    });
    if (!message) throw new NotFoundException('Message introuvable');
    if (message.sender_id !== reporterId) {
      throw new ForbiddenException('Seul l’auteur peut signaler ce message');
    }
    if (message.moderation_status === MessageModerationStatus.CLEAN) {
      throw new BadRequestException('Ce message n’a rien de masqué');
    }

    await this.prisma.redactionReport.create({
      data: { message_id: messageId, reporter_id: reporterId, note },
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Membership, re-asserted at the service layer.
   *
   * The controller checks it too. That duplication is the repo's convention,
   * written out in `contact-unlock.service.ts`: guard at the route AND
   * re-affirm in the service, so a second caller added later cannot bypass it
   * by not knowing the rule.
   */
  private async requireParticipant(
    conversationId: string,
    profileId: string,
  ): Promise<ProfileConversation> {
    const conversation = await this.prisma.profileConversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) throw new NotFoundException('Discussion introuvable');
    if (
      conversation.worker_id !== profileId &&
      conversation.employer_id !== profileId
    ) {
      // NotFound, not Forbidden: "this exists but is not yours" tells a prober
      // that a given pair is talking, which is itself information.
      throw new NotFoundException('Discussion introuvable');
    }
    return conversation;
  }

  private async unreadCounts(
    profileId: string,
    conversationIds: string[],
  ): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const grouped = await this.prisma.profileMessage.groupBy({
      by: ['conversation_id'],
      where: {
        conversation_id: { in: conversationIds },
        sender_id: { not: profileId },
        read_at: null,
        deleted_at: null,
        moderation_status: { not: MessageModerationStatus.HELD },
      },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.conversation_id, g._count._all]));
  }

  /**
   * Whether this conversation is still moderated.
   *
   * Once both parties have paid, they hold each other's numbers already —
   * delivered by the unlock itself over WhatsApp. Masking on would be theatre,
   * and theatre that breaks "rappelle-moi sur l'autre numéro".
   */
  private async shouldModerate(
    conversation: ProfileConversation,
  ): Promise<boolean> {
    if (await this.moderateAfterUnlock()) return true;
    if (!conversation.application_id) return true;

    const attempt = await this.prisma.contactUnlockAttempt.findFirst({
      where: { application_id: conversation.application_id },
      select: { status: true },
    });
    return attempt?.status !== ContactUnlockStatus.UNLOCKED;
  }

  private toMessageView(
    row: {
      id: string;
      conversation_id: string;
      sender_id: string;
      body: string;
      moderation_status: MessageModerationStatus;
      created_at: Date;
      read_at: Date | null;
      redactions: {
        start_offset: number;
        end_offset: number;
        category: RedactionCategory;
      }[];
    },
    viewerId: string,
  ): MessageView {
    const mine = row.sender_id === viewerId;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      mine,
      body: this.bodyFor(row, viewerId),
      status: row.moderation_status,
      // OFFSETS ARE THE AUTHOR'S ALONE. Handing them to the recipient would
      // tell them exactly where to ask "what did you write there?", which is
      // the one thing this feature is built to prevent.
      redactions: mine
        ? row.redactions.map((r) => ({
            start: r.start_offset,
            end: r.end_offset,
            category: r.category,
          }))
        : [],
      createdAt: row.created_at,
      readAt: row.read_at,
    };
  }

  /**
   * The single place that decides which text a given reader gets.
   *
   * Everything else routes through here so the rule cannot be forgotten in one
   * branch: the author sees what they typed, everybody else sees it holed.
   */
  private bodyFor(
    row: {
      body: string;
      sender_id: string;
      moderation_status: MessageModerationStatus;
      redactions: { start_offset: number; end_offset: number }[];
    },
    viewerId: string,
  ): string {
    if (row.sender_id === viewerId) return row.body;
    if (row.moderation_status === MessageModerationStatus.HELD) return '';
    if (row.redactions.length === 0) return row.body;

    // Rebuilt from the STORED offsets rather than by running the detector
    // again: patterns change, and a message must read the same tomorrow as it
    // did when it was sent.
    let out = row.body;
    for (const span of [...row.redactions].sort(
      (a, b) => b.start_offset - a.start_offset,
    )) {
      out =
        out.slice(0, span.start_offset) +
        '[masqué]' +
        out.slice(span.end_offset);
    }
    return out;
  }

  private async isEnabled(): Promise<boolean> {
    return (await this.config.get(ENABLED_KEY, 'true')) !== 'false';
  }

  private async moderateAfterUnlock(): Promise<boolean> {
    return (
      (await this.config.get(MODERATE_AFTER_UNLOCK_KEY, 'false')) === 'true'
    );
  }
}
