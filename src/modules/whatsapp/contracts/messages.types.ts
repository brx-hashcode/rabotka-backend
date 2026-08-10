import type { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';

export type ProviderName = 'twilio' | 'cloud';

/**
 * Canonical internal phone format: E.164 with the leading `+`, e.g.
 * `+242069917686`.
 *
 * Every method on the port takes this shape. Neither provider accepts it as-is
 * — Twilio wants `whatsapp:+242…`, Cloud wants bare digits — and converting is
 * the job of `toProviderAddress()` in each mapper, nowhere else.
 */
export type E164 = string;

export interface SendResult {
  /** Twilio SID (`SM…`/`MM…`) or Cloud wamid (`wamid.…`). */
  providerMessageId: string;
  provider: ProviderName;
  /** Debug only. Never persisted, never logged where a token could ride along. */
  raw?: unknown;
}

/**
 * The logical name of a template, e.g. `'kyc'` or `'reminder24h'`.
 *
 * Derived from the existing registry rather than redeclared, so the two can
 * never drift. Call sites pass this; the `contentSid` / Cloud template name it
 * resolves to is the mapper's business.
 */
export type TemplateKey = keyof typeof WHATSAPP_TEMPLATES;

/**
 * The parameters one specific template takes.
 *
 * Read off the registry's existing `variables()` signature, which is already
 * exhaustively typed per template — so passing `{ jobTitle }` to a template
 * that wants `{ offerTitle, jobOfferId }` is a compile error, and stays one as
 * templates change, with no second list to maintain.
 *
 * Templates taking no parameters resolve to `undefined`.
 */
export type TemplateParams<K extends TemplateKey = TemplateKey> = Parameters<
  (typeof WHATSAPP_TEMPLATES)[K]['variables']
>[0];

export interface OutboundMedia {
  kind: 'image' | 'video' | 'document' | 'audio';
  /** Publicly reachable URL. Both providers fetch it themselves. */
  url: string;
  caption?: string;
  /** Document filename shown in the chat. Ignored for non-document kinds. */
  filename?: string;
}

export interface InteractiveButton {
  /** Echoed back on tap. Keep it stable — the bot flows route on this value. */
  id: string;
  title: string;
}

export interface InteractiveButtonsPayload {
  body: string;
  header?: string;
  footer?: string;
  /** WhatsApp caps this at 3. */
  buttons: InteractiveButton[];
}

export interface InteractiveListRow {
  id: string;
  title: string;
  description?: string;
}

export interface InteractiveListSection {
  title: string;
  rows: InteractiveListRow[];
}

export interface InteractiveListPayload {
  body: string;
  header?: string;
  footer?: string;
  /** Label on the button that opens the list. WhatsApp caps this at 20 chars. */
  buttonText: string;
  sections: InteractiveListSection[];
}

export interface CarouselCard {
  /** Header media for the card. WhatsApp requires every card to carry one. */
  mediaUrl: string;
  body: string;
  buttons: InteractiveButton[];
}

export interface CarouselPayload {
  body: string;
  /** WhatsApp requires at least 2 and at most 10. */
  cards: CarouselCard[];
}

export interface OutboundLocation {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

export interface FlowPayload {
  body: string;
  header?: string;
  footer?: string;
  flowId: string;
  flowCta: string;
  /**
   * Echoed back on submission, and the only correlation between an answer and
   * the person who was asked — the reply carries neither a profile nor the
   * sender's number.
   */
  flowToken?: string;
  /** Screen the flow opens on, plus whatever data it needs to render. */
  screen: string;
  data?: Record<string, string | number | boolean>;
}

export interface SendOptions {
  /**
   * Correlates the eventual status callback back to our own record without a
   * lookup on the provider's message id. Cloud carries it as
   * `biz_opaque_callback_data`; Twilio has no equivalent and ignores it.
   */
  internalMessageId?: string;
}
