import type { WhatsappErrorCode } from './errors';
import type { E164, ProviderName } from './messages.types';

export type DeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';

export interface NormalizedError {
  code: WhatsappErrorCode;
  providerCode: string | number | null;
  message: string;
}

/**
 * What arrived, normalized away from the provider's wire shape.
 *
 * `interactive_reply` covers both a quick-reply button tap and a list-row
 * selection: the bot flows only ever read the id, and under Twilio both already
 * arrive indistinguishably as `ButtonPayload`.
 */
export type InboundContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaId: string; caption?: string; mimeType?: string }
  | { type: 'video'; mediaId: string; caption?: string; mimeType?: string }
  | { type: 'audio'; mediaId: string; mimeType?: string }
  | {
      type: 'document';
      mediaId: string;
      filename?: string;
      caption?: string;
      mimeType?: string;
    }
  | {
      type: 'interactive_reply';
      /** The button/row id we set when sending. Bot flows route on this. */
      replyId: string;
      title?: string;
    }
  | {
      type: 'location';
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
    }
  | { type: 'reaction'; emoji: string; targetMessageId: string }
  | {
      /**
       * A submitted WhatsApp Flow — a native in-chat form.
       *
       * `answers` is the parsed `response_json`; `flowToken` is what we set
       * when sending, and the only correlation back to who was asked, since
       * the submission carries no application or profile of its own.
       */
      type: 'flow_reply';
      flowToken?: string;
      answers: Record<string, unknown>;
    }
  | {
      /**
       * Received but not modelled — stickers, contacts, orders, system
       * notifications. Carried through rather than dropped so the bot can
       * answer something rather than appearing to ignore the user.
       */
      type: 'unsupported';
      rawType: string;
    };

export type InboundEvent =
  | {
      kind: 'message';
      from: E164;
      providerMessageId: string;
      timestamp: Date;
      content: InboundContent;
      provider: ProviderName;
      /** Display name from the sender's WhatsApp profile, when the provider sends one. */
      profileName?: string;
    }
  | {
      kind: 'status';
      providerMessageId: string;
      status: DeliveryStatus;
      timestamp: Date;
      provider: ProviderName;
      /** Present on `failed`. */
      error?: NormalizedError;
      /** Echo of `SendOptions.internalMessageId`, when the provider supports it. */
      internalMessageId?: string;
      /** Recipient, when the provider includes it on the status callback. */
      to?: E164;
    };
