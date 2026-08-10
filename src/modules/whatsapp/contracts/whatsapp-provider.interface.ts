import type { ProviderCapabilities } from './capabilities';
import type { InboundEvent } from './inbound.types';
import type {
  CarouselPayload,
  E164,
  FlowPayload,
  InteractiveButtonsPayload,
  InteractiveListPayload,
  OutboundLocation,
  OutboundMedia,
  ProviderName,
  SendOptions,
  SendResult,
  TemplateKey,
  TemplateParams,
} from './messages.types';

/**
 * DI token for the active provider.
 *
 * `WhatsAppService` injects this, never a concrete class — that indirection is
 * the whole point of the abstraction, and the one rule that keeps
 * `WHATSAPP_PROVIDER` honest. Resolved once by a `useFactory` in
 * `WhatsAppModule` from validated config.
 */
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');

/**
 * The port every WhatsApp backend implements.
 *
 * Every method takes NORMALIZED input. Provider wire shapes — `contentSid`,
 * `contentVariables`, `whatsapp:` prefixes, Graph API components — live only
 * inside `providers/<name>/*.mapper.ts` and must not leak through this
 * interface.
 *
 * Methods for capabilities a provider lacks still exist on the implementation.
 * They either degrade to a logged no-op (typing indicators, read receipts) or
 * throw `WhatsappCapabilityError` (everything else). See `capabilities.ts`.
 */
export interface WhatsappProvider {
  readonly name: ProviderName;
  readonly capabilities: ProviderCapabilities;

  /**
   * Whether credentials are present and a client could be built.
   *
   * `false` is a normal state in a dev environment with no credentials, not an
   * incident — sends short-circuit rather than throwing, and the admin status
   * endpoint reports it.
   */
  isConfigured(): boolean;

  sendText(
    to: E164,
    body: string,
    opts?: { previewUrl?: boolean } & SendOptions,
  ): Promise<SendResult>;

  sendTemplate<K extends TemplateKey>(
    to: E164,
    template: K,
    params: TemplateParams<K>,
    opts?: { languageOverride?: string } & SendOptions,
  ): Promise<SendResult>;

  /**
   * Send a template from its already-resolved `{'1': …, '9': …}` variables.
   *
   * MIGRATION ONLY — prefer `sendTemplate`, which types params per template.
   * This exists for jobs that were already sitting in BullMQ when a deploy
   * landed: their payload carries the numbered map and no longer has the typed
   * params it was built from, and those payloads cannot be rewritten in place.
   *
   * Not a provider leak: the numbered map is the registry's own canonical
   * variable form, and both mappers build their wire format from it. Removable
   * one release after the deploy that introduced key-shaped jobs.
   */
  sendTemplateWithVariables(
    to: E164,
    template: TemplateKey,
    variables: Record<string, string>,
    opts?: { languageOverride?: string } & SendOptions,
  ): Promise<SendResult>;

  sendMedia(
    to: E164,
    media: OutboundMedia,
    opts?: SendOptions,
  ): Promise<SendResult>;

  sendInteractiveButtons(
    to: E164,
    payload: InteractiveButtonsPayload,
    opts?: SendOptions,
  ): Promise<SendResult>;

  sendInteractiveList(
    to: E164,
    payload: InteractiveListPayload,
    opts?: SendOptions,
  ): Promise<SendResult>;

  sendCarousel(
    to: E164,
    payload: CarouselPayload,
    opts?: SendOptions,
  ): Promise<SendResult>;

  sendLocation(
    to: E164,
    location: OutboundLocation,
    opts?: SendOptions,
  ): Promise<SendResult>;

  sendReaction(
    to: E164,
    targetProviderMessageId: string,
    /** Empty string removes a previously sent reaction. */
    emoji: string,
  ): Promise<SendResult>;

  sendFlow(
    to: E164,
    payload: FlowPayload,
    opts?: SendOptions,
  ): Promise<SendResult>;

  /** No-op on providers without read receipts. Never throws in production. */
  markAsRead(providerMessageId: string): Promise<void>;

  /** No-op on providers without typing indicators. Never throws in production. */
  sendTypingIndicator(providerMessageId: string): Promise<void>;

  /**
   * Turn a verified webhook payload into normalized events.
   *
   * One payload can carry many events — Cloud nests
   * `entry[] × changes[] × (messages[] | statuses[])` — so this returns an
   * array, and an empty array is a normal outcome, not an error.
   */
  parseInboundWebhook(
    body: unknown,
    headers: Record<string, string>,
  ): Promise<InboundEvent[]>;

  /**
   * Verify a webhook came from the provider.
   *
   * Takes the RAW body: Cloud's HMAC is computed over the exact bytes and a
   * re-serialized JSON object will not match. Twilio's scheme needs the parsed
   * form body and the called URL instead, both of which it reads off `headers`
   * and the request it was handed — see `twilio.provider.ts`.
   */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string>,
  ): boolean;
}
