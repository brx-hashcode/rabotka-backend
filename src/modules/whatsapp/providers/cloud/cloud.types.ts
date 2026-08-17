/**
 * Graph API wire types.
 *
 * Hand-written rather than inferred: these describe what Meta sends and
 * accepts, and the point of the abstraction is that nothing outside this
 * directory ever sees them.
 */

export const MESSAGING_PRODUCT = 'whatsapp' as const;

export interface CloudTextPayload {
  messaging_product: typeof MESSAGING_PRODUCT;
  recipient_type: 'individual';
  to: string;
  type: 'text';
  text: { body: string; preview_url?: boolean };
  biz_opaque_callback_data?: string;
}

export type CloudTemplateParameter =
  | { type: 'text'; text: string }
  | {
      type: 'currency';
      currency: { fallback_value: string; code: string; amount_1000: number };
    }
  | { type: 'date_time'; date_time: { fallback_value: string } }
  | { type: 'image'; image: { link: string } }
  | { type: 'document'; document: { link: string; filename?: string } }
  | { type: 'video'; video: { link: string } }
  /**
   * A FLOW button's send-time parameter. The flow id and the screen live on the
   * APPROVED template, so the only thing a send carries is the token — which is
   * echoed back verbatim on submission and is the sole link between a completed
   * Flow and the profile that was asked.
   */
  | { type: 'action'; action: { flow_token: string } };

export type CloudTemplateComponent =
  | { type: 'header'; parameters: CloudTemplateParameter[] }
  | { type: 'body'; parameters: CloudTemplateParameter[] }
  | {
      type: 'button';
      sub_type: 'url' | 'quick_reply' | 'flow';
      index: string;
      parameters: CloudTemplateParameter[];
    };

export interface CloudTemplatePayload {
  messaging_product: typeof MESSAGING_PRODUCT;
  recipient_type: 'individual';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components?: CloudTemplateComponent[];
  };
  biz_opaque_callback_data?: string;
}

export type CloudMediaKind = 'image' | 'video' | 'document' | 'audio';

export interface CloudMediaPayload {
  messaging_product: typeof MESSAGING_PRODUCT;
  recipient_type: 'individual';
  to: string;
  type: CloudMediaKind;
  image?: { link: string; caption?: string };
  video?: { link: string; caption?: string };
  audio?: { link: string };
  document?: { link: string; caption?: string; filename?: string };
  biz_opaque_callback_data?: string;
}

export interface CloudInteractiveButton {
  type: 'reply';
  reply: { id: string; title: string };
}

export interface CloudInteractiveRow {
  id: string;
  title: string;
  description?: string;
}

export interface CloudInteractivePayload {
  messaging_product: typeof MESSAGING_PRODUCT;
  recipient_type: 'individual';
  to: string;
  type: 'interactive';
  interactive:
    | {
        type: 'button';
        header?: { type: 'text'; text: string };
        body: { text: string };
        footer?: { text: string };
        action: { buttons: CloudInteractiveButton[] };
      }
    | {
        type: 'list';
        header?: { type: 'text'; text: string };
        body: { text: string };
        footer?: { text: string };
        action: {
          button: string;
          sections: { title: string; rows: CloudInteractiveRow[] }[];
        };
      }
    | {
        type: 'flow';
        header?: { type: 'text'; text: string };
        body: { text: string };
        footer?: { text: string };
        action: {
          name: 'flow';
          parameters: {
            flow_message_version: '3';
            /**
             * Echoed back verbatim on submission. A sibling of `flow_id`, NOT
             * part of `flow_action_payload.data` — Meta accepts the message
             * either way and only returns the token when it is here.
             */
            flow_token?: string;
            flow_id: string;
            flow_cta: string;
            flow_action: 'navigate';
            flow_action_payload: {
              screen: string;
              data?: Record<string, string | number | boolean>;
            };
          };
        };
      };
  biz_opaque_callback_data?: string;
}

export interface CloudLocationPayload {
  messaging_product: typeof MESSAGING_PRODUCT;
  recipient_type: 'individual';
  to: string;
  type: 'location';
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  biz_opaque_callback_data?: string;
}

export interface CloudReactionPayload {
  messaging_product: typeof MESSAGING_PRODUCT;
  recipient_type: 'individual';
  to: string;
  type: 'reaction';
  reaction: { message_id: string; emoji: string };
}

/**
 * Read receipt, and typing indicator.
 *
 * The same endpoint and the same payload: omitting `typing_indicator` marks the
 * message read, including it also shows the composer bubble. There is no way to
 * show typing WITHOUT marking the message read — Meta's design, not an accident
 * of this client.
 */
export interface CloudReadPayload {
  messaging_product: typeof MESSAGING_PRODUCT;
  status: 'read';
  message_id: string;
  typing_indicator?: { type: 'text' };
}

export type CloudSendPayload =
  | CloudTextPayload
  | CloudTemplatePayload
  | CloudMediaPayload
  | CloudInteractivePayload
  | CloudLocationPayload
  | CloudReactionPayload;

export interface CloudSendResponse {
  messaging_product: typeof MESSAGING_PRODUCT;
  contacts?: { input: string; wa_id: string }[];
  messages?: { id: string; message_status?: string }[];
}

export interface CloudErrorBody {
  error: {
    message: string;
    type?: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
    error_data?: { messaging_product?: string; details?: string };
  };
}

export function isCloudErrorBody(value: unknown): value is CloudErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  return typeof (error as { code?: unknown }).code === 'number';
}

export function isCloudSendResponse(
  value: unknown,
): value is CloudSendResponse {
  if (typeof value !== 'object' || value === null) return false;
  const messages = (value as { messages?: unknown }).messages;
  if (messages === undefined) return true;
  return Array.isArray(messages);
}

export interface CloudInboundText {
  body: string;
}

export interface CloudInboundMedia {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

export interface CloudInboundInteractive {
  type: 'button_reply' | 'list_reply' | 'nfm_reply';
  button_reply?: { id: string; title: string };
  list_reply?: { id: string; title: string; description?: string };
  /**
   * A submitted Flow ("Native Flow Message" reply).
   *
   * `response_json` is a JSON STRING, not an object — the answers arrive
   * double-encoded, which is easy to miss and yields `[object Object]` if you
   * treat it as parsed. It also carries `flow_token`, echoed back from the
   * send, which is the only thing tying a submission to who was asked.
   */
  nfm_reply?: { name: string; body?: string; response_json: string };
}

export interface CloudInboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: CloudInboundText;
  image?: CloudInboundMedia;
  video?: CloudInboundMedia;
  audio?: CloudInboundMedia;
  document?: CloudInboundMedia;
  sticker?: CloudInboundMedia;
  interactive?: CloudInboundInteractive;
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  reaction?: { message_id: string; emoji: string };
  button?: { payload: string; text: string };
  context?: { from?: string; id?: string };
}

export interface CloudStatusError {
  code: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

/**
 * What Meta will charge for the message.
 *
 * Only present once the message reaches a billable state — it rides on
 * `delivered`, never on `sent` — so a status handler must treat it as
 * optional rather than assuming the first callback carries it.
 */
export interface CloudStatusPricing {
  billable?: boolean;
  pricing_model?: string;
  /** AUTHENTICATION | MARKETING | SERVICE | UTILITY, lowercased by Meta. */
  category?: string;
  /** FREE_CUSTOMER_SERVICE | FREE_ENTRY_POINT | REGULAR. */
  type?: string;
}

export interface CloudStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  biz_opaque_callback_data?: string;
  pricing?: CloudStatusPricing;
  errors?: CloudStatusError[];
}

export interface CloudChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id: string }[];
  messages?: CloudInboundMessage[];
  statuses?: CloudStatus[];
}

export interface CloudChange {
  field: string;
  value: CloudChangeValue;
}

export interface CloudEntry {
  id: string;
  changes?: CloudChange[];
}

export interface CloudWebhookBody {
  object?: string;
  entry?: CloudEntry[];
}
