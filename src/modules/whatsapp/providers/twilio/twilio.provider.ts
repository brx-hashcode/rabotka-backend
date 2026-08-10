import { Injectable, Logger } from '@nestjs/common';
import TwilioSDK from 'twilio';
import { TwilioService } from '../../../../common/services/twilio/twilio.service';
import {
  WhatsappCapabilityError,
  WhatsappError,
  type Capability,
  type CarouselPayload,
  type E164,
  type FlowPayload,
  type InboundEvent,
  type InteractiveButtonsPayload,
  type InteractiveListPayload,
  type OutboundLocation,
  type OutboundMedia,
  type ProviderCapabilities,
  type SendOptions,
  type SendResult,
  type TemplateKey,
  type TemplateParams,
  type WhatsappProvider,
} from '../../contracts';
import { toContentSid, toContentVariables } from './twilio.mapper';
import { toWhatsappError } from './twilio.errors';

/**
 * Twilio-backed implementation of the port.
 *
 * Deliberately a thin adapter over `TwilioService` rather than a rewrite: that
 * class owns the SDK client and the exact error strings the admin back office
 * displays, and this commit must not change what anyone sees. The value added
 * here is the shape — callers pass a `TemplateKey`, not a `contentSid`, and
 * failures arrive as a normalized `WhatsappError`.
 *
 * Everything Twilio expresses only through pre-approved Content templates
 * (buttons, lists, carousels, flows) throws `WhatsappCapabilityError`: the
 * button titles and card layouts live in the Twilio Console, not in this
 * codebase, so there is nothing this provider could honestly build from a
 * normalized payload.
 */
@Injectable()
export class TwilioProvider implements WhatsappProvider {
  readonly name = 'twilio' as const;

  readonly capabilities: ProviderCapabilities = {
    // Twilio's WhatsApp channel exposes neither.
    typingIndicator: false,
    readReceipts: false,
    // Expressible only as an approved Content template, not from a payload.
    interactiveButtons: false,
    interactiveList: false,
    carousel: false,
    flows: false,
    location: false,
    reactions: false,
    freeformOutsideWindow: false,
  };

  private readonly logger = new Logger(TwilioProvider.name);

  constructor(private readonly twilio: TwilioService) {}

  isConfigured(): boolean {
    return this.twilio.isConfigured();
  }

  /**
   * `TwilioService` answers `null` when it has no client at all, and throws on
   * a real send failure. That distinction is load-bearing upstream — an admin
   * is told "WhatsApp is not configured" rather than shown a provider error —
   * so it survives here as a `WhatsappError` with a dedicated code the service
   * layer maps back.
   */
  private toResult(sid: string | null, to: E164): SendResult {
    if (sid === null) {
      throw new WhatsappError({
        code: 'NOT_CONFIGURED',
        provider: 'twilio',
        message: `Twilio is not configured — message to ${to} was not sent`,
        providerCode: null,
      });
    }
    return { providerMessageId: sid, provider: 'twilio' };
  }

  /**
   * Returns a REJECTED promise rather than throwing synchronously. The port
   * returns a Promise, so a caller doing `.catch()` on it would miss a
   * synchronous throw entirely and take down the request instead.
   */
  private unsupported(capability: Capability): Promise<never> {
    return Promise.reject(new WhatsappCapabilityError('twilio', capability));
  }

  async sendText(to: E164, body: string): Promise<SendResult> {
    try {
      return this.toResult(await this.twilio.sendWhatsApp(to, body), to);
    } catch (err) {
      throw err instanceof WhatsappError ? err : toWhatsappError(err);
    }
  }

  sendTemplate<K extends TemplateKey>(
    to: E164,
    template: K,
    params: TemplateParams<K>,
  ): Promise<SendResult> {
    return this.sendTemplateWithVariables(
      to,
      template,
      toContentVariables(template, params),
    );
  }

  async sendTemplateWithVariables(
    to: E164,
    template: TemplateKey,
    variables: Record<string, string>,
  ): Promise<SendResult> {
    try {
      const sid = await this.twilio.sendWhatsAppTemplate(
        to,
        toContentSid(template),
        variables,
      );
      return this.toResult(sid, to);
    } catch (err) {
      throw err instanceof WhatsappError ? err : toWhatsappError(err);
    }
  }

  async sendMedia(to: E164, media: OutboundMedia): Promise<SendResult> {
    try {
      const sid = await this.twilio.sendWhatsAppMedia(
        to,
        media.url,
        media.caption,
      );
      return this.toResult(sid, to);
    } catch (err) {
      throw err instanceof WhatsappError ? err : toWhatsappError(err);
    }
  }

  sendInteractiveButtons(
    _to: E164,
    _payload: InteractiveButtonsPayload,
  ): Promise<SendResult> {
    return this.unsupported('interactiveButtons');
  }

  sendInteractiveList(
    _to: E164,
    _payload: InteractiveListPayload,
  ): Promise<SendResult> {
    return this.unsupported('interactiveList');
  }

  sendCarousel(_to: E164, _payload: CarouselPayload): Promise<SendResult> {
    return this.unsupported('carousel');
  }

  sendLocation(_to: E164, _location: OutboundLocation): Promise<SendResult> {
    return this.unsupported('location');
  }

  sendReaction(
    _to: E164,
    _targetProviderMessageId: string,
    _emoji: string,
  ): Promise<SendResult> {
    return this.unsupported('reactions');
  }

  sendFlow(_to: E164, _payload: FlowPayload): Promise<SendResult> {
    return this.unsupported('flows');
  }

  /**
   * No-ops. Not a capability error: a missing "seen" tick costs the reader
   * nothing, and throwing would force every caller to branch on the provider.
   */
  markAsRead(providerMessageId: string): Promise<void> {
    this.logger.debug(
      `markAsRead(${providerMessageId}) ignored — Twilio has no read receipts`,
    );
    return Promise.resolve();
  }

  sendTypingIndicator(providerMessageId: string): Promise<void> {
    this.logger.debug(
      `sendTypingIndicator(${providerMessageId}) ignored — Twilio has no typing indicator`,
    );
    return Promise.resolve();
  }

  /**
   * Twilio's signature covers the parsed form body plus the exact URL it
   * called, so unlike Cloud's HMAC this cannot be computed from the raw buffer
   * alone. The URL has to be reconstructed behind the proxy, which the webhook
   * controller does — it passes the result through `headers['x-webhook-url']`.
   */
  verifyWebhookSignature(
    _rawBody: Buffer,
    headers: Record<string, string>,
  ): boolean {
    const signature = headers['x-twilio-signature'];
    const url = headers['x-webhook-url'];
    const token = this.twilio.getAuthToken();
    if (!signature || !url || !token) return false;

    const form = headers['x-webhook-form'];
    let body: Record<string, string> = {};
    if (form) {
      try {
        body = JSON.parse(form) as Record<string, string>;
      } catch {
        return false;
      }
    }
    return TwilioSDK.validateRequest(token, signature, url, body);
  }

  parseInboundWebhook(_body: unknown): Promise<InboundEvent[]> {
    // Wired in the webhook commit, alongside the Cloud normalizer — the
    // existing controller still parses Twilio's form payload inline today.
    return Promise.resolve([]);
  }
}

/** Keeps `SendOptions` referenced until the Cloud provider gives it meaning. */
export type TwilioSendOptions = SendOptions;
