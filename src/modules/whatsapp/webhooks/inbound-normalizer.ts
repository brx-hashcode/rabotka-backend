import { toE164 } from '../contracts/address';
import type {
  DeliveryStatus,
  InboundContent,
  InboundEvent,
  NormalizedError,
} from '../contracts';
import { cloudErrorCode } from '../providers/cloud/cloud.errors';
import type {
  CloudInboundMessage,
  CloudStatus,
  CloudWebhookBody,
} from '../providers/cloud/cloud.types';

/**
 * Turn a provider's webhook payload into the normalized event union.
 *
 * Pure. The controllers own signature verification and the HTTP contract; this
 * owns the shape translation, so both can be tested without a request.
 */

/** Meta sends Unix SECONDS as a string. `new Date(string)` would parse it wrong. */
function toDate(timestamp: string | undefined): Date {
  const seconds = Number(timestamp);
  if (!timestamp || Number.isNaN(seconds)) return new Date();
  return new Date(seconds * 1000);
}

function toCloudContent(message: CloudInboundMessage): InboundContent {
  switch (message.type) {
    case 'text':
      return { type: 'text', text: message.text?.body ?? '' };

    case 'interactive': {
      // A submitted Flow. Handled before the reply-button case because it is
      // the same `interactive` envelope with a completely different payload.
      const flow = message.interactive?.nfm_reply;
      if (flow) {
        const answers = parseFlowAnswers(flow.response_json);
        return {
          type: 'flow_reply',
          // Set by us at send time and echoed back untouched. Nothing else in
          // the submission says who was asked.
          flowToken:
            typeof answers.flow_token === 'string'
              ? answers.flow_token
              : undefined,
          answers,
        };
      }

      // A tap on a reply button or a list row. Both carry an id we chose when
      // sending, and the bot flows route on that id — the title is for logs.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply;
      return {
        type: 'interactive_reply',
        replyId: reply?.id ?? '',
        title: reply?.title,
      };
    }

    case 'button':
      // A quick-reply button on a TEMPLATE arrives as `button`, not
      // `interactive` — a separate shape for what is the same user action, and
      // the one Twilio surfaces as ButtonPayload. Normalized identically so the
      // flows cannot tell the providers apart.
      return {
        type: 'interactive_reply',
        replyId: message.button?.payload ?? '',
        title: message.button?.text,
      };

    case 'image':
      return {
        type: 'image',
        mediaId: message.image?.id ?? '',
        caption: message.image?.caption,
        mimeType: message.image?.mime_type,
      };

    case 'video':
      return {
        type: 'video',
        mediaId: message.video?.id ?? '',
        caption: message.video?.caption,
        mimeType: message.video?.mime_type,
      };

    case 'audio':
      return {
        type: 'audio',
        mediaId: message.audio?.id ?? '',
        mimeType: message.audio?.mime_type,
      };

    case 'document':
      return {
        type: 'document',
        mediaId: message.document?.id ?? '',
        filename: message.document?.filename,
        caption: message.document?.caption,
        mimeType: message.document?.mime_type,
      };

    case 'location':
      return {
        type: 'location',
        latitude: message.location?.latitude ?? 0,
        longitude: message.location?.longitude ?? 0,
        name: message.location?.name,
        address: message.location?.address,
      };

    case 'reaction':
      return {
        type: 'reaction',
        emoji: message.reaction?.emoji ?? '',
        targetMessageId: message.reaction?.message_id ?? '',
      };

    default:
      // Stickers, contacts, orders, system notifications. Carried through
      // rather than dropped so the bot can answer something instead of
      // appearing to ignore the user.
      return { type: 'unsupported', rawType: message.type };
  }
}

/**
 * The Flow's answers, which arrive as a JSON STRING inside the reply.
 *
 * Double-encoded, and quietly: treating `response_json` as an object yields
 * "[object Object]" rather than an error. Returns `{}` on anything unparseable
 * — a malformed submission should lose its answers, not the webhook.
 */
function parseFlowAnswers(responseJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(responseJson);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toDeliveryStatus(status: string): DeliveryStatus | null {
  if (
    status === 'sent' ||
    status === 'delivered' ||
    status === 'read' ||
    status === 'failed'
  ) {
    return status;
  }
  return null;
}

function toNormalizedError(status: CloudStatus): NormalizedError | undefined {
  const first = status.errors?.[0];
  if (!first) return undefined;
  return {
    code: cloudErrorCode(first.code),
    providerCode: first.code,
    message: first.error_data?.details ?? first.title ?? first.message ?? '',
  };
}

/**
 * Normalize a Cloud webhook body.
 *
 * ONE PAYLOAD CAN CARRY MANY EVENTS: Meta batches
 * `entry[] × changes[] × (messages[] | statuses[])`, and reading
 * `entry[0].changes[0]` — the shape every tutorial shows — silently drops the
 * rest under load, which is exactly when it matters.
 */
export function normalizeCloudWebhook(body: CloudWebhookBody): InboundEvent[] {
  const events: InboundEvent[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;

      // Display names arrive alongside the messages rather than on them.
      const namesByWaId = new Map<string, string | undefined>(
        (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]),
      );

      for (const message of value.messages ?? []) {
        events.push({
          kind: 'message',
          from: toE164(message.from),
          providerMessageId: message.id,
          timestamp: toDate(message.timestamp),
          content: toCloudContent(message),
          provider: 'cloud',
          profileName: namesByWaId.get(message.from),
        });
      }

      for (const status of value.statuses ?? []) {
        const normalized = toDeliveryStatus(status.status);
        // An unrecognized status is skipped rather than guessed at: inventing a
        // delivery state would corrupt the telemetry it feeds.
        if (!normalized) continue;
        events.push({
          kind: 'status',
          providerMessageId: status.id,
          status: normalized,
          timestamp: toDate(status.timestamp),
          provider: 'cloud',
          error: toNormalizedError(status),
          internalMessageId: status.biz_opaque_callback_data,
          to: status.recipient_id ? toE164(status.recipient_id) : undefined,
        });
      }
    }
  }

  return events;
}

/** Twilio's delivery-status callback values, which are not inbound messages. */
const TWILIO_DELIVERY_STATUSES = new Set([
  'sent',
  'delivered',
  'read',
  'undelivered',
  'failed',
  'queued',
  'sending',
]);

function toTwilioDeliveryStatus(status: string): DeliveryStatus | null {
  if (status === 'undelivered') return 'failed';
  return toDeliveryStatus(status);
}

/**
 * Normalize a Twilio webhook body.
 *
 * Twilio posts form-encoded fields, and sends inbound messages and delivery
 * status callbacks to the SAME url — `MessageStatus` is what tells them apart.
 * Returns at most one event; the batching is a Cloud concern.
 */
export function normalizeTwilioWebhook(
  form: Record<string, string>,
): InboundEvent[] {
  const status = form.MessageStatus;
  if (status && TWILIO_DELIVERY_STATUSES.has(status)) {
    const normalized = toTwilioDeliveryStatus(status);
    if (!normalized) return [];
    return [
      {
        kind: 'status',
        providerMessageId: form.MessageSid ?? '',
        status: normalized,
        timestamp: new Date(),
        provider: 'twilio',
        ...(form.ErrorCode
          ? {
              error: {
                code: 'UNKNOWN',
                providerCode: Number(form.ErrorCode),
                message: form.ErrorMessage ?? '',
              },
            }
          : {}),
        ...(form.To ? { to: toE164(form.To) } : {}),
      },
    ];
  }

  const from = form.From;
  if (!from) return [];

  // A quick-reply tap arrives as ButtonPayload (the id we set) plus ButtonText.
  // Prefer the payload so replies route into the numeric-token bot flows, and
  // normalize it to the same interactive_reply Cloud produces.
  const content: InboundContent = form.ButtonPayload
    ? {
        type: 'interactive_reply',
        replyId: form.ButtonPayload,
        title: form.ButtonText,
      }
    : { type: 'text', text: form.ButtonText || form.Body || '' };

  return [
    {
      kind: 'message',
      from: toE164(from),
      providerMessageId: form.MessageSid ?? '',
      timestamp: new Date(),
      content,
      provider: 'twilio',
      profileName: form.ProfileName,
    },
  ];
}

/**
 * The text the bot should act on, for a message event.
 *
 * The bot graph consumes a single string, so an interactive reply collapses to
 * its id — the same value Twilio's ButtonPayload already produced — and a media
 * message to its caption. `null` means there is nothing for the bot to answer.
 */
export function toBotInput(event: InboundEvent): string | null {
  if (event.kind !== 'message') return null;
  const content = event.content;
  switch (content.type) {
    case 'text':
      return content.text;
    case 'interactive_reply':
      return content.replyId;
    case 'flow_reply':
      // Handled by the feedback path, not the bot graph — there is no text for
      // a flow submission and answering it with a bot reply would be noise.
      return null;
    case 'image':
    case 'video':
    case 'document':
      return content.caption ?? '';
    default:
      return '';
  }
}
