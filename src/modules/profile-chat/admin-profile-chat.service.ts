import { Injectable, NotFoundException } from '@nestjs/common';
import {
  MessageModerationStatus,
  Prisma,
  RedactionCategory,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  AdminListConversationsDto,
  ConversationFlag,
  ConversationStatusFilter,
} from './dto/admin-list-conversations.dto';

/**
 * One party, as the back-office needs them.
 *
 * `hiddenAt` and `lastReadAt` are METADATA here, never a filter — see the class
 * docblock. They are the answer to "the worker swears they never saw that
 * message", which is a question this module exists to settle.
 */
export type AdminConversationParty = {
  id: string;
  name: string;
  /** Phone, not email: most profiles here have no email, and phone is identity. */
  phone: string;
  avatarUrl: string | null;
  lastReadAt: string | null;
  hiddenAt: string | null;
};

/**
 * A conversation as the LIST shows it.
 *
 * CARRIES NO MESSAGE TEXT — no body, no preview, not one character. The list is
 * a MODERATOR surface and reading what people said is a MANAGER act, logged
 * separately. A truncated last-message preview, which is what the end-user list
 * builds for its own rows, is message body: it would put the tier-two surface
 * inside the tier-one one and make the whole permission split decorative.
 */
export type AdminConversationListItem = {
  id: string;
  worker: AdminConversationParty;
  employer: AdminConversationParty;
  /** Null means cold outreach: nobody applied, one side simply wrote. */
  applicationId: string | null;
  jobOfferId: string | null;
  jobTitle: string | null;
  messageCount: number;
  redactedCount: number;
  heldCount: number;
  pendingReportCount: number;
  /** Null when every message was held: nothing was ever delivered. */
  lastMessageAt: string | null;
  closedAt: string | null;
  createdAt: string;
};

export type AdminConversationListResult = {
  data: AdminConversationListItem[];
  total: number;
  page: number;
  limit: number;
};

export type AdminConversationDetail = AdminConversationListItem & {
  cleanCount: number;
  semanticFlaggedCount: number;
  deletedCount: number;
  /** Per category, over the whole thread. The false-positive corpus in miniature. */
  redactionsByCategory: Record<RedactionCategory, number>;
};

/**
 * One withheld fragment, as offsets into the RAW body.
 *
 * `matchedBy` is the rule that fired. It is what turns "this pattern produces
 * most of our false positives" into a query instead of an afternoon of reading
 * strangers' messages, so it is surfaced rather than kept for the database.
 */
export type AdminRedactionView = {
  start: number;
  end: number;
  category: RedactionCategory;
  matchedBy: string;
};

export type AdminMessageView = {
  id: string;
  senderId: string;
  senderName: string;
  /** Which side of the conversation wrote it. There is no "mine" for an admin. */
  senderSide: 'WORKER' | 'EMPLOYER';
  /**
   * THE RAW TEXT, exactly as typed — including what the recipient never saw.
   *
   * This is the one field in the module that is worth a log row per read, and
   * it is why the endpoint serving it sits on its own controller at MANAGER.
   */
  body: string;
  status: MessageModerationStatus;
  semanticFlagged: boolean;
  redactions: AdminRedactionView[];
  reports: {
    id: string;
    note: string | null;
    reviewedAt: string | null;
    upheld: boolean | null;
  }[];
  readAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};

export type AdminThreadResult = {
  data: AdminMessageView[];
  total: number;
  page: number;
  limit: number;
  /** Echoed back so the audit row can name both parties without a second read. */
  workerId: string;
  employerId: string;
};

const PARTY_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  phone: true,
  avatar_url: true,
} as const;

const CONVERSATION_INCLUDE = {
  worker: { select: PARTY_SELECT },
  employer: { select: PARTY_SELECT },
  application: {
    select: { id: true, job_offer: { select: { id: true, title: true } } },
  },
} as const;

type ConversationRow = Prisma.ProfileConversationGetPayload<{
  include: typeof CONVERSATION_INCLUDE;
}>;

/** Per-conversation tallies, gathered for a whole page in one round trip each. */
type Counts = {
  total: number;
  redacted: number;
  held: number;
  clean: number;
  pendingReports: number;
};

const EMPTY_COUNTS: Counts = {
  total: 0,
  redacted: 0,
  held: 0,
  clean: 0,
  pendingReports: 0,
};

/**
 * Back-office reads over user-to-user conversations.
 *
 * A SEPARATE SERVICE, not a role flag on `ProfileChatService`. Every public
 * method there takes a `profileId` and runs `requireParticipant`; every private
 * helper is parameterized on that same id and encodes a participant-relative
 * rule — which text you get, whose redaction offsets you get, what counts as
 * unread for you. Those rules are precisely the ones an admin exists to bypass,
 * so reusing them would mean calling them with a viewer who is not a viewer.
 * That is the shape of the bug that eventually serves a raw body to a recipient.
 *
 * Three deliberate departures from the end-user list, each of which looks like
 * an oversight until you know why:
 *
 * 1. NO `last_message_at: { not: null }`. The end-user list filters those out
 *    (`profile-chat.service.ts:417`) to hide threads nobody has written in. But
 *    `sendMessage` does not bump `last_message_at` for a HELD message, so a
 *    conversation in which EVERY message was withheld whole also has a null —
 *    and that is the single most interesting row in the table. An account that
 *    only ever tries to send phone numbers is exactly who is being looked for.
 *
 * 2. NO `worker_hidden_at` / `employer_hidden_at` clause. Those mean "clear this
 *    thread from MY list" — a per-side convenience, never a delete. The admin is
 *    neither side, so the flag has no referent for them; respecting it would
 *    make a conversation visible or not depending on which party last tapped
 *    Supprimer. And a moderation tool that the person under suspicion can empty
 *    is not a moderation tool. Both timestamps are surfaced as metadata instead.
 *
 * 3. HELD and soft-deleted messages are INCLUDED in the counts, and in the
 *    thread. A held message reached nobody, so the stored row is the only copy
 *    of it that will ever exist — not in the recipient's client, not in a push,
 *    not in the bell. It is also the strongest evidence there is of a deliberate
 *    contact exchange: CLEAN is nothing, REDACTED is one fragment, HELD is a
 *    message that was mostly contact details.
 */
@Injectable()
export class AdminProfileChatService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    dto: AdminListConversationsDto,
  ): Promise<AdminConversationListResult> {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 10;
    const where = this.buildWhere(dto);

    const [rows, total] = await Promise.all([
      this.prisma.profileConversation.findMany({
        where,
        // Newest activity first, and NULLS LAST explicitly: Postgres puts NULLs
        // first on a DESC sort, which would float every held-only and
        // never-written thread above genuinely recent traffic. They are reached
        // through the HELD flag instead, which is the deliberate way in.
        orderBy: [
          { last_message_at: { sort: 'desc', nulls: 'last' } },
          { created_at: 'desc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
        include: CONVERSATION_INCLUDE,
      }),
      this.prisma.profileConversation.count({ where }),
    ]);

    const counts = await this.countsFor(rows.map((row) => row.id));

    return {
      data: rows.map((row) =>
        this.toListItem(row, counts.get(row.id) ?? EMPTY_COUNTS),
      ),
      total,
      page,
      limit,
    };
  }

  async detail(id: string): Promise<AdminConversationDetail> {
    const row = await this.prisma.profileConversation.findUnique({
      where: { id },
      include: CONVERSATION_INCLUDE,
    });
    if (!row) throw new NotFoundException('Conversation introuvable');

    const [counts, byCategory, deletedCount, semanticFlaggedCount] =
      await Promise.all([
        this.countsFor([id]),
        this.redactionsByCategory(id),
        this.prisma.profileMessage.count({
          where: { conversation_id: id, deleted_at: { not: null } },
        }),
        this.prisma.profileMessage.count({
          where: { conversation_id: id, semantic_flagged: true },
        }),
      ]);

    return {
      ...this.toListItem(row, counts.get(id) ?? EMPTY_COUNTS),
      cleanCount: (counts.get(id) ?? EMPTY_COUNTS).clean,
      semanticFlaggedCount,
      deletedCount,
      redactionsByCategory: byCategory,
    };
  }

  /**
   * Lock a conversation: neither party may write in it again.
   *
   * THE FIRST WRITER OF `closed_at` anywhere in the codebase. Nothing else sets
   * it — the architecture note imagines an event listener closing a thread when
   * its application dies, and that listener was never built — so there is no
   * prior meaning to conform to and no second writer to race.
   *
   * Nothing is deleted and nobody is told twice: both parties keep every
   * message, the client already renders the closed state from this flag, and
   * `sendMessage` already refuses on it. So the whole feature on the user's side
   * is this one column.
   *
   * Idempotent. Closing a closed conversation returns the current state rather
   * than moving `closed_at` forward, so a double tap cannot rewrite when it
   * happened — which is the field somebody will later be asked to justify.
   */
  async close(id: string): Promise<AdminConversationDetail> {
    const existing = await this.requireConversation(id);
    if (!existing.closed_at) {
      await this.prisma.profileConversation.update({
        where: { id },
        data: { closed_at: new Date() },
      });
    }
    return this.detail(id);
  }

  /**
   * Unlock it again.
   *
   * Ships WITH close, never after. This is the only writer of the column, so
   * without reopen a misclick is permanent and the remedy is hand-written SQL
   * against production. A destructive control with no undo is not a control.
   */
  async reopen(id: string): Promise<AdminConversationDetail> {
    const existing = await this.requireConversation(id);
    if (existing.closed_at) {
      await this.prisma.profileConversation.update({
        where: { id },
        data: { closed_at: null },
      });
    }
    return this.detail(id);
  }

  /**
   * The thread itself — the only read in this service that returns message text.
   *
   * No `deleted_at` filter, no HELD filter, no per-side hiding: the admin gets
   * every row the conversation has ever held. A held message in particular
   * exists NOWHERE else — it was never delivered, never pushed, never put in the
   * bell — so this is the only place a human can ever read it.
   *
   * The body is returned verbatim. `bodyFor` in `ProfileChatService` is the one
   * function that decides which text a reader gets, and it is keyed on being a
   * participant; calling it here with an admin would be a lie encoded in a call
   * site. It is deliberately not reused.
   */
  async messages(
    id: string,
    page = 1,
    limit = 50,
  ): Promise<AdminThreadResult> {
    const conversation = await this.prisma.profileConversation.findUnique({
      where: { id },
      select: { id: true, worker_id: true, employer_id: true },
    });
    // Thrown BEFORE anything is returned, so the controller's audit row is never
    // written for a conversation that does not exist. Logging a 404 would turn
    // the audit trail into a probe log.
    if (!conversation) throw new NotFoundException('Conversation introuvable');

    const where: Prisma.ProfileMessageWhereInput = { conversation_id: id };

    const [total, rows] = await Promise.all([
      this.prisma.profileMessage.count({ where }),
      this.prisma.profileMessage.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          redactions: {
            select: {
              start_offset: true,
              end_offset: true,
              category: true,
              matched_by: true,
            },
            orderBy: { start_offset: 'asc' },
          },
          reports: {
            select: {
              id: true,
              note: true,
              reviewed_at: true,
              upheld: true,
            },
          },
          sender: { select: { first_name: true, last_name: true } },
        },
      }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        senderId: row.sender_id,
        senderName: `${row.sender.first_name} ${row.sender.last_name}`,
        senderSide:
          row.sender_id === conversation.worker_id
            ? ('WORKER' as const)
            : ('EMPLOYER' as const),
        body: row.body,
        status: row.moderation_status,
        semanticFlagged: row.semantic_flagged,
        redactions: row.redactions.map((redaction) => ({
          start: redaction.start_offset,
          end: redaction.end_offset,
          category: redaction.category,
          matchedBy: redaction.matched_by,
        })),
        reports: row.reports.map((report) => ({
          id: report.id,
          note: report.note,
          reviewedAt: report.reviewed_at?.toISOString() ?? null,
          upheld: report.upheld,
        })),
        readAt: row.read_at?.toISOString() ?? null,
        deletedAt: row.deleted_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      })),
      total,
      page,
      limit,
      workerId: conversation.worker_id,
      employerId: conversation.employer_id,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async requireConversation(
    id: string,
  ): Promise<{ id: string; closed_at: Date | null }> {
    const conversation = await this.prisma.profileConversation.findUnique({
      where: { id },
      select: { id: true, closed_at: true },
    });
    if (!conversation) throw new NotFoundException('Conversation introuvable');
    return conversation;
  }

  private buildWhere(
    dto: AdminListConversationsDto,
  ): Prisma.ProfileConversationWhereInput {
    const where: Prisma.ProfileConversationWhereInput = {};

    if (dto.worker_id) where.worker_id = dto.worker_id;
    if (dto.employer_id) where.employer_id = dto.employer_id;

    if (dto.since || dto.until) {
      where.last_message_at = {
        ...(dto.since && { gte: dto.since }),
        ...(dto.until && { lt: dto.until }),
      };
    }

    const status = dto.status ?? [];
    // Asking for both is asking for no filter at all, which is what the absence
    // of the key already means.
    if (status.length === 1) {
      where.closed_at = this.closedFilter(status[0]);
    }

    // AND-ed, not OR-ed: a moderator narrowing by two flags is looking for a
    // conversation that satisfies both, not either.
    const flags = dto.flags ?? [];
    const and: Prisma.ProfileConversationWhereInput[] = [];
    for (const flag of flags) {
      const clause = this.flagClause(flag);
      if (clause) and.push(clause);
    }
    if (and.length) where.AND = and;

    const q = dto.q?.trim();
    if (q) {
      // Split so "Marie Employeuse" matches across first_name + last_name — the
      // same shape as the contact-records list, because a single `contains` on
      // either column finds nothing for the most natural thing an admin types.
      const parts = q.split(/\s+/).filter(Boolean);
      const nameMatch = (
        party: 'worker' | 'employer',
      ): Prisma.ProfileConversationWhereInput[] =>
        parts.length > 1
          ? [
              {
                [party]: {
                  first_name: { contains: parts[0], mode: 'insensitive' },
                  last_name: {
                    contains: parts.slice(1).join(' '),
                    mode: 'insensitive',
                  },
                },
              },
            ]
          : [
              { [party]: { first_name: { contains: q, mode: 'insensitive' } } },
              { [party]: { last_name: { contains: q, mode: 'insensitive' } } },
            ];

      where.OR = [
        ...nameMatch('worker'),
        ...nameMatch('employer'),
        {
          application: {
            job_offer: { title: { contains: q, mode: 'insensitive' } },
          },
        },
      ];
    }

    return where;
  }

  private closedFilter(
    status: ConversationStatusFilter,
  ): Prisma.ProfileConversationWhereInput['closed_at'] {
    return status === 'CLOSED' ? { not: null } : null;
  }

  private flagClause(
    flag: ConversationFlag,
  ): Prisma.ProfileConversationWhereInput | null {
    switch (flag) {
      case 'HELD':
        return {
          messages: {
            some: { moderation_status: MessageModerationStatus.HELD },
          },
        };
      case 'REDACTED':
        return {
          messages: {
            some: { moderation_status: MessageModerationStatus.REDACTED },
          },
        };
      case 'REPORTED':
        return { messages: { some: { reports: { some: { reviewed_at: null } } } } };
      case 'DIRECT':
        return { application_id: null };
      default:
        return null;
    }
  }

  /**
   * Moderation tallies for a whole page, in two round trips rather than two per
   * row — the same reason `toViews` batches its own lookups.
   */
  private async countsFor(ids: string[]): Promise<Map<string, Counts>> {
    const counts = new Map<string, Counts>();
    if (ids.length === 0) return counts;

    const [byStatus, reported] = await Promise.all([
      this.prisma.profileMessage.groupBy({
        by: ['conversation_id', 'moderation_status'],
        where: { conversation_id: { in: ids } },
        _count: { _all: true },
      }),
      // One row per message carrying an unreviewed report, tallied here. Going
      // through messages rather than grouping reports is what gives us the
      // conversation id — a report hangs off a message, not a conversation.
      this.prisma.profileMessage.findMany({
        where: {
          conversation_id: { in: ids },
          reports: { some: { reviewed_at: null } },
        },
        select: { conversation_id: true },
      }),
    ]);

    const at = (id: string): Counts => {
      const existing = counts.get(id);
      if (existing) return existing;
      const fresh = { ...EMPTY_COUNTS };
      counts.set(id, fresh);
      return fresh;
    };

    for (const group of byStatus) {
      const row = at(group.conversation_id);
      const n = group._count._all;
      row.total += n;
      if (group.moderation_status === MessageModerationStatus.REDACTED) {
        row.redacted += n;
      } else if (group.moderation_status === MessageModerationStatus.HELD) {
        row.held += n;
      } else {
        row.clean += n;
      }
    }

    for (const message of reported) at(message.conversation_id).pendingReports += 1;

    return counts;
  }

  /**
   * Per-category redaction counts for ONE conversation.
   *
   * Detail only, never the list: `MessageRedaction` carries no conversation id,
   * so a page-wide version would have to pull every redaction row on the page
   * and tally in memory. For one thread that cost is bounded and worth it.
   */
  private async redactionsByCategory(
    conversationId: string,
  ): Promise<Record<RedactionCategory, number>> {
    const groups = await this.prisma.messageRedaction.groupBy({
      by: ['category'],
      where: { message: { conversation_id: conversationId } },
      _count: { _all: true },
    });

    const byCategory = Object.fromEntries(
      Object.values(RedactionCategory).map((category) => [category, 0]),
    ) as Record<RedactionCategory, number>;

    for (const group of groups) byCategory[group.category] = group._count._all;
    return byCategory;
  }

  private toListItem(
    row: ConversationRow,
    counts: Counts,
  ): AdminConversationListItem {
    return {
      id: row.id,
      worker: this.toParty(
        row.worker,
        row.worker_last_read_at,
        row.worker_hidden_at,
      ),
      employer: this.toParty(
        row.employer,
        row.employer_last_read_at,
        row.employer_hidden_at,
      ),
      applicationId: row.application_id,
      jobOfferId: row.application?.job_offer.id ?? null,
      jobTitle: row.application?.job_offer.title ?? null,
      messageCount: counts.total,
      redactedCount: counts.redacted,
      heldCount: counts.held,
      pendingReportCount: counts.pendingReports,
      lastMessageAt: row.last_message_at?.toISOString() ?? null,
      closedAt: row.closed_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
    };
  }

  private toParty(
    profile: { id: string; first_name: string; last_name: string; phone: string; avatar_url: string | null },
    lastReadAt: Date | null,
    hiddenAt: Date | null,
  ): AdminConversationParty {
    return {
      id: profile.id,
      name: `${profile.first_name} ${profile.last_name}`,
      phone: profile.phone,
      avatarUrl: profile.avatar_url ?? null,
      lastReadAt: lastReadAt?.toISOString() ?? null,
      hiddenAt: hiddenAt?.toISOString() ?? null,
    };
  }
}
