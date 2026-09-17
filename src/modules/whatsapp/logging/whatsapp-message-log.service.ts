import { Injectable, Logger } from '@nestjs/common';
import {
  MessageDirection,
  Prisma,
  WhatsappDeliveryStatus,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  WhatsappError,
  type InboundContent,
  type InboundEvent,
  type TemplateKey,
} from '../contracts';
import { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';
import { toDigits, toE164 } from '../contracts/address';

/**
 * The durable record of every WhatsApp message, sent or received.
 *
 * Before this existed the pipeline was amnesiac: `WhatsAppService.attempt()`
 * received Meta's wamid and reduced it to a boolean, and `handleStatus()`
 * dropped `sent`/`read` outright, logged `failed` once and fed `delivered` into
 * a Redis histogram with a 15-minute TTL. Nobody could answer "did that message
 * arrive?" an hour later, let alone a week.
 *
 * EVERY METHOD HERE IS BEST-EFFORT. Bookkeeping must never fail a send: the
 * outbound processor turns a thrown error into a BullMQ retry, and a retry
 * RESENDS the message. So each method swallows its own failures and logs them —
 * the same trade the existing guarded `saveMessage()` calls make.
 */

/** Longest `body_preview` we store. Enough to identify a message in a table. */
const BODY_PREVIEW_MAX = 2000;

/**
 * How far a status may advance the row.
 *
 * Meta batches status webhooks and does not guarantee order — a `sent` can land
 * after a `read`, and under retries it frequently does. Ranking them means a
 * late callback can only ever move the row forward, so the table shows the
 * furthest point the message actually reached rather than the last packet to
 * arrive. FAILED is deliberately highest: a message that failed did not
 * subsequently get read, and a stale earlier callback must not hide that.
 */
const STATUS_RANK: Record<WhatsappDeliveryStatus, number> = {
  [WhatsappDeliveryStatus.QUEUED]: 0,
  [WhatsappDeliveryStatus.SENT]: 1,
  [WhatsappDeliveryStatus.DELIVERED]: 2,
  [WhatsappDeliveryStatus.READ]: 3,
  [WhatsappDeliveryStatus.FAILED]: 4,
  // Inbound rows only. Status webhooks carry OUR wamids, so none ever
  // correlates to a received message; ranked lowest so that if one somehow
  // did, it could not be mistaken for a later state.
  [WhatsappDeliveryStatus.RECEIVED]: 0,
};

type MessageEvent = Extract<InboundEvent, { kind: 'message' }>;

/** The shape of an outbound send, as far as the log is concerned. */
export type WhatsappSendKind =
  | 'text'
  | 'template'
  | 'media'
  | 'flow'
  | 'interactive'
  /**
   * A free-form message with a URL button — what a bot reply sends instead of
   * an approved template.
   *
   * Its own kind rather than plain `interactive`, because these rows carry no
   * `template_key` and would otherwise vanish from the per-template consumption
   * view: the moment this shipped, the traffic would read as messages that
   * stopped being sent rather than messages that stopped being billed.
   */
  | 'interactive_cta';

export interface SendLogContext {
  kind: WhatsappSendKind;
  /** Rendered text, template body, or a `[IMG:…]`-style descriptor. */
  bodyPreview: string;
  templateKey?: TemplateKey;
  profileId?: string;
  /** Set when an admin composed the message by hand. */
  sentById?: string;
  /**
   * The template's arguments, for templates.
   *
   * Stored as given rather than normalized to the numbered `{'1': …}` form:
   * `{ jobTitle: 'Ménage bureau' }` is what an admin reading the log needs,
   * and the positional map is meaningless without the template beside it.
   */
  variables?: Record<string, unknown>;
}

@Injectable()
export class WhatsappMessageLogService {
  private readonly logger = new Logger(WhatsappMessageLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Open a row for a send that is about to happen, returning its id.
   *
   * Written BEFORE the provider call on purpose. The id goes out as
   * `biz_opaque_callback_data` and comes back on every status webhook, so the
   * row is guaranteed to exist by the time a delivery receipt can arrive —
   * which removes the race that a write-after-send would have.
   *
   * Returns `null` if the insert failed. Callers treat that as "no logging for
   * this one" and carry on; they must not skip the send.
   */
  async begin(phone: string, ctx: SendLogContext): Promise<string | null> {
    try {
      const row = await this.prisma.whatsappMessage.create({
        data: {
          provider: 'pending',
          direction: MessageDirection.OUTBOUND,
          to_phone: phone,
          profile_id: ctx.profileId ?? (await this.profileIdForPhone(phone)),
          kind: ctx.kind,
          template_key: ctx.templateKey ?? null,
          template_category: ctx.templateKey
            ? (WHATSAPP_TEMPLATES[ctx.templateKey]?.category ?? null)
            : null,
          body_preview: truncate(ctx.bodyPreview),
          // Prisma's `InputJsonValue` does not accept an open
          // `Record<string, unknown>`; the values here are template arguments,
          // which are always JSON-serializable by construction.
          variables: (ctx.variables as Prisma.InputJsonValue) ?? undefined,
          status: WhatsappDeliveryStatus.QUEUED,
          sent_by_id: ctx.sentById ?? null,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      // ERROR, not warn, and with the stack.
      //
      // This returning null is not a detail — it is a message going out that
      // nobody can ever trace. It stayed a warn for two days while the dev
      // worker logged nothing whatsoever (`this.prisma` was undefined under
      // `tsx`; see the note at the top of `src/worker.ts`), and the only clue
      // anywhere was one line that read like routine noise.
      //
      // The kind and template are here so the line says WHAT went unlogged
      // without needing the surrounding request.
      const template = ctx.templateKey ? ` template=${ctx.templateKey}` : '';
      this.logger.error(
        `Could not open a WhatsApp log row — this send will be UNTRACEABLE. ` +
          `to=${phone} kind=${ctx.kind}${template}: ${reason(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return null;
    }
  }

  /**
   * The profile that owns this number, for the sends that do not name one.
   *
   * Most callers have no `profileId` to hand — a bot reply knows the number it
   * is answering, not the row behind it — and without this every such row read
   * "no profile" in the back office even when the recipient was a perfectly
   * ordinary registered user. The phone is the only key an outbound WhatsApp
   * send always carries, so it is the one to join on.
   *
   * Both stored shapes are tried because `profiles.phone` is not canonical:
   * `toE164`'s own doc notes the column disagrees with the webhook and with
   * whatever an admin typed. Matching one shape alone would silently miss.
   *
   * Never throws and never blocks the send: an unresolved profile is a slightly
   * poorer log row, not a reason to lose the message.
   */
  private async profileIdForPhone(phone: string): Promise<string | null> {
    try {
      const e164 = toE164(phone);
      const profile = await this.prisma.profile.findFirst({
        where: { phone: { in: [e164, toDigits(phone)] } },
        select: { id: true },
      });
      return profile?.id ?? null;
    } catch {
      return null;
    }
  }

  /** The provider accepted the message. Record its id and stamp `sent_at`. */
  async markSent(
    id: string | null,
    providerMessageId: string,
    provider: string,
  ): Promise<void> {
    if (!id) return;
    try {
      await this.prisma.whatsappMessage.update({
        where: { id },
        data: {
          provider,
          provider_message_id: providerMessageId,
          status: WhatsappDeliveryStatus.SENT,
          sent_at: new Date(),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Could not mark WhatsApp message ${id} as sent: ${reason(err)}`,
      );
    }
  }

  /**
   * The provider rejected the message, so there is no wamid and no webhook
   * will ever arrive. This row is terminal from here.
   */
  async markFailed(
    id: string | null,
    provider: string,
    err: unknown,
  ): Promise<void> {
    if (!id) return;
    const isKnown = err instanceof WhatsappError;
    try {
      await this.prisma.whatsappMessage.update({
        where: { id },
        data: {
          provider,
          status: WhatsappDeliveryStatus.FAILED,
          failed_at: new Date(),
          error_code: isKnown ? err.code : 'UNKNOWN',
          error_provider_code:
            isKnown && typeof err.providerCode === 'number'
              ? err.providerCode
              : null,
          error_message: truncate(reason(err), 500),
        },
      });
    } catch (updateErr) {
      this.logger.warn(
        `Could not mark WhatsApp message ${id} as failed: ${reason(updateErr)}`,
      );
    }
  }

  /**
   * Record a message someone sent us, and remember who they are.
   *
   * Every inbound message, whatever its type and whoever sent it. Registered
   * users' text also lands in the `messages` transcript, but a stranger's has
   * nowhere else to go — `messages.profile_id` is NOT NULL — so until this
   * existed their words were kept for thirty minutes in Redis and then lost.
   *
   * `create` rather than `upsert`, and the unique violation is the signal: a
   * Meta replay or a re-delivered batch carries the same wamid, and it must
   * neither add a row nor count the contact twice.
   */
  async recordInbound(event: MessageEvent): Promise<void> {
    const phone = event.from;
    const profileName = event.profileName?.trim() || null;
    let profileId: string | null = null;

    try {
      profileId = await this.profileIdForPhone(phone);
      await this.prisma.whatsappMessage.create({
        data: {
          provider: event.provider,
          provider_message_id: event.providerMessageId || null,
          direction: MessageDirection.INBOUND,
          to_phone: phone,
          profile_id: profileId,
          kind: event.content.type,
          body_preview: truncate(describeInbound(event.content)),
          variables: inboundDetails(event.content) ?? undefined,
          status: WhatsappDeliveryStatus.RECEIVED,
          wa_profile_name: profileName,
          received_at: event.timestamp,
        },
        select: { id: true },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.debug(
          `Inbound ${event.providerMessageId} already logged — replay ignored`,
        );
        return;
      }
      this.logger.error(
        `Could not log inbound WhatsApp message from ${phone} ` +
          `(${event.content.type}, ${event.providerMessageId}): ${reason(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      // Fall through: the contact is worth keeping even when the row is not.
    }

    await this.touchContact(phone, profileName, profileId, event.timestamp);
  }

  /**
   * Keep the per-phone directory current.
   *
   * The name is only written when the event carries one: Twilio omits it on
   * some payloads, and a missing name must not erase one we already know.
   */
  private async touchContact(
    phone: string,
    profileName: string | null,
    profileId: string | null,
    seenAt: Date,
  ): Promise<void> {
    try {
      await this.prisma.whatsappContact.upsert({
        where: { phone },
        create: {
          phone,
          wa_profile_name: profileName,
          profile_id: profileId,
          first_seen_at: seenAt,
          last_seen_at: seenAt,
          inbound_count: 1,
        },
        update: {
          last_seen_at: seenAt,
          inbound_count: { increment: 1 },
          ...(profileId ? { profile_id: profileId } : {}),
          ...(profileName ? { wa_profile_name: profileName } : {}),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Could not update WhatsApp contact ${phone}: ${reason(err)}`,
      );
    }
  }

  /**
   * Apply one delivery-status webhook to its row.
   *
   * Correlation prefers `internalMessageId` — our own row id, echoed back by
   * Meta in `biz_opaque_callback_data` — and falls back to the provider's
   * message id, which is all the Twilio path has (Twilio has no opaque-data
   * equivalent and ignores the field).
   *
   * A status for a message we never logged is expected, not an error: rows
   * predating this feature, and anything sent by a script outside the app.
   * Logged at debug so it does not drown the real failures.
   */
  async applyStatus(
    event: Extract<InboundEvent, { kind: 'status' }>,
  ): Promise<void> {
    const next = toDeliveryStatus(event.status);

    try {
      const row = await this.findRow(event);
      if (!row) {
        this.logger.debug(
          `Status "${event.status}" for an unlogged message ` +
            `${event.providerMessageId} — ignored`,
        );
        return;
      }

      const data: Record<string, unknown> = {};

      // Only ever move forward. Meta reorders under retry, and a `sent` landing
      // after a `read` must not walk the row backwards.
      if (STATUS_RANK[next] > STATUS_RANK[row.status]) {
        data.status = next;
      }

      // Timestamps are set unconditionally, unlike the status: a late `sent`
      // callback still tells us truthfully when the message was sent, even
      // though the row has moved past SENT by then.
      const stamp = timestampColumn(next);
      if (stamp && row[stamp] === null) data[stamp] = event.timestamp;

      // Meta attaches pricing to `delivered`, not to `sent`, so it has to be
      // merged in whenever it shows up rather than read off the first callback.
      if (event.pricing?.category)
        data.pricing_category = event.pricing.category;
      if (event.pricing?.billable !== undefined) {
        data.billable = event.pricing.billable;
      }

      if (event.error) {
        data.error_code = event.error.code;
        data.error_provider_code =
          typeof event.error.providerCode === 'number'
            ? event.error.providerCode
            : null;
        data.error_message = truncate(event.error.message, 500);
      }

      // The provider id is our only handle on a Twilio row until the first
      // callback arrives, so backfill it when the match came via our own id.
      if (!row.provider_message_id && event.providerMessageId) {
        data.provider_message_id = event.providerMessageId;
      }

      if (Object.keys(data).length === 0) return;

      await this.prisma.whatsappMessage.update({
        where: { id: row.id },
        data,
      });
    } catch (err) {
      this.logger.warn(
        `Could not apply status "${event.status}" to ` +
          `${event.providerMessageId}: ${reason(err)}`,
      );
    }
  }

  /**
   * Locate the row a status belongs to.
   *
   * Two lookups rather than one `OR`, because they are not equivalent: the
   * internal id is a primary key and always resolves to the right row, whereas
   * a provider id could in principle be reused across a provider flip. Trying
   * the authoritative one first keeps that ambiguity out of the result.
   */
  private async findRow(event: Extract<InboundEvent, { kind: 'status' }>) {
    const select = {
      id: true,
      status: true,
      provider_message_id: true,
      sent_at: true,
      delivered_at: true,
      read_at: true,
      failed_at: true,
    } as const;

    if (event.internalMessageId) {
      const byInternal = await this.prisma.whatsappMessage.findUnique({
        where: { id: event.internalMessageId },
        select,
      });
      if (byInternal) return byInternal;
    }

    if (!event.providerMessageId) return null;

    return this.prisma.whatsappMessage.findUnique({
      where: { provider_message_id: event.providerMessageId },
      select,
    });
  }
}

function toDeliveryStatus(status: string): WhatsappDeliveryStatus {
  switch (status) {
    case 'sent':
      return WhatsappDeliveryStatus.SENT;
    case 'delivered':
      return WhatsappDeliveryStatus.DELIVERED;
    case 'read':
      return WhatsappDeliveryStatus.READ;
    default:
      return WhatsappDeliveryStatus.FAILED;
  }
}

type TimestampColumn = 'sent_at' | 'delivered_at' | 'read_at' | 'failed_at';

function timestampColumn(
  status: WhatsappDeliveryStatus,
): TimestampColumn | null {
  switch (status) {
    case WhatsappDeliveryStatus.SENT:
      return 'sent_at';
    case WhatsappDeliveryStatus.DELIVERED:
      return 'delivered_at';
    case WhatsappDeliveryStatus.READ:
      return 'read_at';
    case WhatsappDeliveryStatus.FAILED:
      return 'failed_at';
    default:
      return null;
  }
}

/**
 * A readable one-liner for an inbound message, for the log's content column.
 *
 * Exported for its own table test: every content type needs a line an admin
 * can read, and a new type falling through to an empty cell is easy to miss.
 */
export function describeInbound(content: InboundContent): string {
  switch (content.type) {
    case 'text':
      return content.text;
    case 'interactive_reply':
      return content.title ?? content.replyId;
    case 'image':
      return withCaption('[Image]', content.caption);
    case 'video':
      return withCaption('[Video]', content.caption);
    case 'document':
      return withCaption(
        content.filename ? `[Document: ${content.filename}]` : '[Document]',
        content.caption,
      );
    case 'audio':
      return '[Voice note]';
    case 'location': {
      const place = [content.name, content.address].filter(Boolean).join(', ');
      return place
        ? `[Location] ${place}`
        : `[Location] ${content.latitude}, ${content.longitude}`;
    }
    case 'reaction':
      return content.emoji
        ? `[Reaction ${content.emoji}]`
        : '[Reaction removed]';
    case 'flow_reply':
      return '[Form submitted]';
    case 'unsupported':
      return `[${content.rawType}]`;
  }
}

/** The structured parts of an inbound message, kept alongside the preview. */
function inboundDetails(content: InboundContent): Prisma.InputJsonValue | null {
  switch (content.type) {
    case 'text':
      return null;
    case 'interactive_reply':
      return { replyId: content.replyId, title: content.title ?? null };
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
      return {
        mediaId: content.mediaId,
        mimeType: content.mimeType ?? null,
        ...(content.type === 'document'
          ? { filename: content.filename ?? null }
          : {}),
      };
    case 'location':
      return {
        latitude: content.latitude,
        longitude: content.longitude,
        name: content.name ?? null,
        address: content.address ?? null,
      };
    case 'reaction':
      return { emoji: content.emoji, targetMessageId: content.targetMessageId };
    case 'flow_reply':
      // Answers are free-form JSON parsed from the provider payload, so they
      // are serializable by construction.
      return {
        flowToken: content.flowToken ?? null,
        answers: content.answers as Prisma.InputJsonValue,
      };
    case 'unsupported':
      return { rawType: content.rawType };
  }
}

function withCaption(label: string, caption?: string): string {
  return caption ? `${label} ${caption}` : label;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

function truncate(value: string, max = BODY_PREVIEW_MAX): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
