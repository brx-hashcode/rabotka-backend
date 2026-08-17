import { Injectable, Logger } from '@nestjs/common';
import {
  MessageDirection,
  Prisma,
  WhatsappDeliveryStatus,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  WhatsappError,
  type InboundEvent,
  type TemplateKey,
} from '../contracts';
import { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';
import { toDigits, toE164 } from '../contracts/address';

/**
 * The durable record of every outbound WhatsApp send.
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
};

/** The shape of an outbound send, as far as the log is concerned. */
export type WhatsappSendKind =
  | 'text'
  | 'template'
  | 'media'
  | 'flow'
  | 'interactive';

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
      this.logger.warn(
        `Could not open a WhatsApp log row for ${phone}: ${reason(err)}`,
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

function truncate(value: string, max = BODY_PREVIEW_MAX): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
