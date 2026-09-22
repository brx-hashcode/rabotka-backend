import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  ApplicationStatus,
  ContactUnlockStatus,
  MessageModerationStatus,
  Prisma,
  ProfileType,
  type ProfileConversation,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  notificationDedupeKey,
  notifyProfile,
} from '../profile-notification/profile-notification.events';
import { SystemConfigService } from '../system-config/system-config.service';
import { MESSAGING_NUDGE_QUEUE } from '../../common/services/queue/queue.module';
import { QueueService } from '../../common/services/queue/queue.service';
import { nudgeJobId, type MessagingNudgeJob } from './profile-chat.nudge';
import { ModerationService } from './moderation/moderation.service';
import { ProfileChatGateway } from './profile-chat.gateway';
import { PresenceService } from './presence.service';
import type { RedactionCategory } from './moderation/patterns';

/**
 * How long one conversation's bell entry stands in for the next message.
 *
 * Half an hour: long enough that a back-and-forth leaves one row, short enough
 * that a reply the next morning still announces itself. Not configurable yet —
 * there is no evidence to tune it against until real threads exist.
 */
const NOTIFICATION_DEDUPE_SECONDS = 30 * 60;

/** Fallback when `messaging.nudge_delay_seconds` is unset or nonsense. */
const DEFAULT_NUDGE_DELAY_SECONDS = 300;
const NUDGE_DELAY_KEY = 'messaging.nudge_delay_seconds';

/** Unsolicited threads one profile may start per rolling day. */
const DEFAULT_MAX_NEW_CONVERSATIONS = 20;
const MAX_NEW_CONVERSATIONS_KEY = 'messaging.max_new_conversations_per_day';

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
  counterpartAvatarUrl: string | null;
  /** Connected right now, on any instance. False when Redis cannot say. */
  counterpartOnline: boolean;
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
    private readonly gateway: ProfileChatGateway,
    private readonly events: EventEmitter2,
    private readonly queue: QueueService,
    private readonly presence: PresenceService,
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

  /**
   * Opens a conversation with a profile DIRECTLY, with no application behind
   * it — an employer writing to a recommended worker who has not applied to
   * anything.
   *
   * This is the case `application_id` was made nullable for, and it is the
   * mission's own scenario: the whole point of moderated messaging is to let
   * two people talk BEFORE either pays to unlock contact details. An employer
   * looking at a recommended profile is exactly that moment.
   *
   * It does not leak the 1000 FCFA recommendation fee. Nothing said here can
   * carry a phone number — that is what the moderation is for — so the fee
   * still buys the only thing it ever bought: the actual contact details.
   *
   * WHAT IT DOES COST is consent. On the application path the worker chose to
   * engage by applying; here nobody chose anything, and an employer could open
   * a thread with every profile they are shown. Hence the daily cap below,
   * which is the price of allowing this at all.
   */
  async openWithProfile(
    counterpartId: string,
    actorId: string,
  ): Promise<ProfileConversation> {
    if (counterpartId === actorId) {
      throw new BadRequestException('Vous ne pouvez pas vous écrire à vous-même');
    }
    if (!(await this.isEnabled())) {
      throw new BadRequestException(
        'La messagerie est momentanément indisponible',
      );
    }

    const [actor, counterpart] = await Promise.all([
      this.prisma.profile.findFirst({
        where: { id: actorId, deleted_at: null },
        select: { id: true, profile_type: true },
      }),
      this.prisma.profile.findFirst({
        where: { id: counterpartId, deleted_at: null },
        select: { id: true, profile_type: true, status: true },
      }),
    ]);
    if (!actor) throw new NotFoundException('Profil introuvable');
    if (!counterpart || counterpart.status !== AccountStatus.ACTIVE) {
      // Same answer for "does not exist" and "not active": otherwise this
      // endpoint tells anybody who asks whether a given profile is suspended.
      throw new NotFoundException('Profil introuvable');
    }
    if (actor.profile_type === counterpart.profile_type) {
      throw new BadRequestException(
        'Une discussion relie un employeur et un travailleur',
      );
    }

    const isEmployer = actor.profile_type === ProfileType.EMPLOYER;
    const workerId = isEmployer ? counterpartId : actorId;
    const employerId = isEmployer ? actorId : counterpartId;

    const existing = await this.prisma.profileConversation.findFirst({
      where: {
        worker_id: workerId,
        employer_id: employerId,
        application_id: null,
      },
    });
    if (existing) return existing;

    // Checked only when a NEW thread would be created. Re-opening one that
    // already exists is not reaching out to anybody new, and counting it would
    // make the cap tighten every time somebody returns to a conversation they
    // are already in.
    await this.assertUnderDailyCap(actorId);

    try {
      return await this.prisma.profileConversation.create({
        data: { worker_id: workerId, employer_id: employerId },
      });
    } catch (error) {
      // The partial unique index caught a double tap. Same recovery as the
      // application path: re-read rather than fail.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.prisma.profileConversation.findFirst({
          where: {
            worker_id: workerId,
            employer_id: employerId,
            application_id: null,
          },
        });
        if (raced) return raced;
      }
      throw error;
    }
  }

  /**
   * How many unsolicited threads one profile may start in a day.
   *
   * The only thing standing between "talk before you pay" and a mailing list.
   * Counts conversations with no application behind them, because the
   * application path carries the worker's own consent and needs no ceiling.
   */
  private async assertUnderDailyCap(actorId: string): Promise<void> {
    const cap = await this.maxNewConversationsPerDay();
    if (cap <= 0) return;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const started = await this.prisma.profileConversation.count({
      where: {
        application_id: null,
        created_at: { gte: since },
        OR: [{ worker_id: actorId }, { employer_id: actorId }],
      },
    });

    if (started >= cap) {
      throw new BadRequestException(
        'Vous avez ouvert trop de discussions aujourd’hui, réessayez demain',
      );
    }
  }

  private async maxNewConversationsPerDay(): Promise<number> {
    const raw = await this.config.get(
      MAX_NEW_CONVERSATIONS_KEY,
      String(DEFAULT_MAX_NEW_CONVERSATIONS),
    );
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_MAX_NEW_CONVERSATIONS;
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
          worker: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              avatar_url: true,
            },
          },
          employer: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              avatar_url: true,
            },
          },
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

    // One grouped count and one pipeline rather than a query per row: a list of
    // 20 conversations would otherwise be 41 round trips.
    const [unread, online] = await Promise.all([
      this.unreadCounts(
        profileId,
        rows.map((r) => r.id),
      ),
      this.presence.onlineAmong(
        rows.map((r) => (r.worker_id === profileId ? r.employer_id : r.worker_id)),
      ),
    ]);

    return {
      data: rows.map((row) => {
        const isWorker = row.worker_id === profileId;
        const counterpart = isWorker ? row.employer : row.worker;
        const last = row.messages[0];

        return {
          id: row.id,
          counterpartId: counterpart.id,
          counterpartName: `${counterpart.first_name} ${counterpart.last_name}`,
          counterpartAvatarUrl: counterpart.avatar_url ?? null,
          counterpartOnline: online.has(counterpart.id),
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

    const authorView = this.toMessageView(message, senderId);

    // Pushed as the RECIPIENT'S view, built by the same code path the HTTP
    // response uses. `deliverableFor` returns null for a held message, which is
    // what stops a push announcing something nobody may read.
    const recipientId =
      conversation.worker_id === senderId
        ? conversation.employer_id
        : conversation.worker_id;
    const delivered = this.deliverableFor(
      this.toMessageView(message, recipientId),
      recipientId,
    );
    if (delivered) {
      this.gateway.emitMessage(recipientId, delivered);
      await this.notifyRecipient(conversation, senderId, recipientId);
      await this.scheduleNudge(conversationId, recipientId);
    }

    return authorView;
  }

  /**
   * Queues a delayed "you have an unread message" for the recipient.
   *
   * Three layers now reach the same person, and each covers what the one above
   * it cannot: the socket reaches an open tab, the bell reaches somebody who
   * opens the app later, and this reaches somebody who does not open it at all
   * — which on a WhatsApp-first platform is most people, most of the time.
   *
   * Delayed rather than immediate, because the job re-checks at fire time
   * whether anything is still unread. Somebody who reads within the window is
   * never nudged, and a back-and-forth produces one job rather than a dozen
   * (see `nudgeJobId`).
   *
   * Failures are swallowed on purpose: a queue that is down must not fail the
   * send. The message is already stored and already pushed; losing the nudge is
   * a smaller harm than a 500 on a message that actually went through.
   */
  private async scheduleNudge(
    conversationId: string,
    recipientId: string,
  ): Promise<void> {
    try {
      const delaySeconds = await this.nudgeDelaySeconds();
      await this.queue.addJob<MessagingNudgeJob>(
        MESSAGING_NUDGE_QUEUE,
        { conversationId, recipientId },
        {
          delay: delaySeconds * 1000,
          jobId: nudgeJobId(conversationId, recipientId, delaySeconds),
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not schedule the nudge for ${recipientId}: ${(error as Error).message}`,
      );
    }
  }

  private async nudgeDelaySeconds(): Promise<number> {
    const raw = await this.config.get(
      NUDGE_DELAY_KEY,
      String(DEFAULT_NUDGE_DELAY_SECONDS),
    );
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_NUDGE_DELAY_SECONDS;
  }

  /**
   * Raises the in-app bell for the recipient — ONCE PER CONVERSATION, not once
   * per message.
   *
   * The socket push only reaches somebody who already has the app open, so
   * without this a message lands silently for everybody else. But a chat
   * produces dozens of events an hour, and one feed row each would bury every
   * other notification a person has.
   *
   * `dedupeKey` on the conversation with a window solves both: a burst leaves
   * one row, and a genuinely new exchange an hour later raises a fresh one. The
   * mechanism is already there — `IdempotencyService` behind
   * `notifyProfile` — so this is a key and a TTL, not new machinery.
   *
   * The notification carries the sender's name and the job title, never the
   * message. Feed rows are rendered at write time and stored, so any text
   * copied here would outlive a later correction to what should have been
   * withheld.
   */
  private async notifyRecipient(
    conversation: ProfileConversation,
    senderId: string,
    recipientId: string,
  ): Promise<void> {
    const [sender, application] = await Promise.all([
      this.prisma.profile.findUnique({
        where: { id: senderId },
        select: { first_name: true, last_name: true },
      }),
      conversation.application_id
        ? this.prisma.application.findUnique({
            where: { id: conversation.application_id },
            select: { job_offer: { select: { title: true } } },
          })
        : Promise.resolve(null),
    ]);
    if (!sender) return;

    notifyProfile(this.events, {
      recipientId,
      actorId: senderId,
      dedupeKey: notificationDedupeKey('msg', conversation.id, recipientId),
      dedupeTtlSeconds: NOTIFICATION_DEDUPE_SECONDS,
      input: {
        type: 'NEW_MESSAGE',
        conversationId: conversation.id,
        senderName: `${sender.first_name} ${sender.last_name}`,
        jobTitle: application?.job_offer.title ?? null,
      },
    });
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
