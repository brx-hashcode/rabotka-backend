import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CloudProviderConfig } from '../../whatsapp.config';
import {
  WhatsappError,
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
import { CloudClient } from './cloud.client';
import {
  toProviderAddress,
  toTemplatePayload,
  toTemplatePayloadFromParams,
} from './cloud.mapper';
import { transportError } from './cloud.errors';
import {
  MESSAGING_PRODUCT,
  type CloudInteractiveButton,
  type CloudSendResponse,
} from './cloud.types';

/**
 * Meta WhatsApp Cloud API implementation of the port.
 *
 * Everything provider-specific — the wire shapes, the digits-only recipient
 * format, the Graph error codes — stops here and in the sibling mapper/client
 * files. Callers see the same normalized types they do for Twilio.
 */
export class CloudProvider implements WhatsappProvider {
  readonly name = 'cloud' as const;

  readonly capabilities: ProviderCapabilities = {
    typingIndicator: true,
    readReceipts: true,
    interactiveButtons: true,
    interactiveList: true,
    // A carousel on Cloud is an approved TEMPLATE with carousel components and
    // a fixed card count, not something assemblable from a payload at send
    // time. False until such a template exists in the registry.
    carousel: false,
    flows: true,
    location: true,
    reactions: true,
    freeformOutsideWindow: false,
  };

  private readonly logger = new Logger(CloudProvider.name);
  private readonly client: CloudClient;

  constructor(private readonly config: CloudProviderConfig) {
    this.client = new CloudClient(config);
  }

  isConfigured(): boolean {
    // The zod schema already refused to boot without these; kept a real check
    // rather than `return true` so a future config path cannot bypass it.
    return Boolean(this.config.accessToken && this.config.phoneNumberId);
  }

  private toResult(response: CloudSendResponse, what: string): SendResult {
    const id = response.messages?.[0]?.id;
    if (!id) {
      // A 200 with no wamid means accepted but not queued. Reporting success
      // would claim a delivery that never happened.
      throw transportError(
        `[Cloud] ${what} returned 200 without a message id`,
        response,
      );
    }
    return { providerMessageId: id, provider: 'cloud', raw: response };
  }

  async sendText(
    to: E164,
    body: string,
    opts?: { previewUrl?: boolean } & SendOptions,
  ): Promise<SendResult> {
    const response = await this.client.send({
      messaging_product: MESSAGING_PRODUCT,
      recipient_type: 'individual',
      to: toProviderAddress(to),
      type: 'text',
      text: { body, ...(opts?.previewUrl ? { preview_url: true } : {}) },
      ...(opts?.internalMessageId
        ? { biz_opaque_callback_data: opts.internalMessageId }
        : {}),
    });
    return this.toResult(response, 'text');
  }

  async sendTemplate<K extends TemplateKey>(
    to: E164,
    template: K,
    params: TemplateParams<K>,
    opts?: { languageOverride?: string } & SendOptions,
  ): Promise<SendResult> {
    const response = await this.client.send(
      toTemplatePayloadFromParams(to, template, params, opts),
    );
    return this.toResult(response, `template ${template}`);
  }

  async sendTemplateWithVariables(
    to: E164,
    template: TemplateKey,
    variables: Record<string, string>,
    opts?: { languageOverride?: string } & SendOptions,
  ): Promise<SendResult> {
    const response = await this.client.send(
      toTemplatePayload(to, template, variables, opts),
    );
    return this.toResult(response, `template ${template}`);
  }

  async sendMedia(
    to: E164,
    media: OutboundMedia,
    opts?: SendOptions,
  ): Promise<SendResult> {
    const link = { link: media.url };
    const captioned = media.caption ? { caption: media.caption } : {};
    const response = await this.client.send({
      messaging_product: MESSAGING_PRODUCT,
      recipient_type: 'individual',
      to: toProviderAddress(to),
      type: media.kind,
      ...(media.kind === 'image' ? { image: { ...link, ...captioned } } : {}),
      ...(media.kind === 'video' ? { video: { ...link, ...captioned } } : {}),
      ...(media.kind === 'audio' ? { audio: link } : {}),
      ...(media.kind === 'document'
        ? {
            document: {
              ...link,
              ...captioned,
              ...(media.filename ? { filename: media.filename } : {}),
            },
          }
        : {}),
      ...(opts?.internalMessageId
        ? { biz_opaque_callback_data: opts.internalMessageId }
        : {}),
    });
    return this.toResult(response, media.kind);
  }

  async sendInteractiveButtons(
    to: E164,
    payload: InteractiveButtonsPayload,
    opts?: SendOptions,
  ): Promise<SendResult> {
    if (payload.buttons.length === 0 || payload.buttons.length > 3) {
      // Meta caps reply buttons at 3 and rejects an empty action. Failing here
      // names the problem; the API error would not.
      throw new WhatsappError({
        code: 'UNKNOWN',
        provider: 'cloud',
        message: `Interactive buttons must number 1-3, got ${payload.buttons.length}`,
        providerCode: null,
      });
    }
    const buttons: CloudInteractiveButton[] = payload.buttons.map((b) => ({
      type: 'reply',
      reply: { id: b.id, title: b.title },
    }));
    const response = await this.client.send({
      messaging_product: MESSAGING_PRODUCT,
      recipient_type: 'individual',
      to: toProviderAddress(to),
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(payload.header
          ? { header: { type: 'text' as const, text: payload.header } }
          : {}),
        body: { text: payload.body },
        ...(payload.footer ? { footer: { text: payload.footer } } : {}),
        action: { buttons },
      },
      ...(opts?.internalMessageId
        ? { biz_opaque_callback_data: opts.internalMessageId }
        : {}),
    });
    return this.toResult(response, 'interactive_buttons');
  }

  async sendInteractiveList(
    to: E164,
    payload: InteractiveListPayload,
    opts?: SendOptions,
  ): Promise<SendResult> {
    const response = await this.client.send({
      messaging_product: MESSAGING_PRODUCT,
      recipient_type: 'individual',
      to: toProviderAddress(to),
      type: 'interactive',
      interactive: {
        type: 'list',
        ...(payload.header
          ? { header: { type: 'text' as const, text: payload.header } }
          : {}),
        body: { text: payload.body },
        ...(payload.footer ? { footer: { text: payload.footer } } : {}),
        action: {
          button: payload.buttonText,
          sections: payload.sections.map((section) => ({
            title: section.title,
            rows: section.rows.map((row) => ({
              id: row.id,
              title: row.title,
              ...(row.description ? { description: row.description } : {}),
            })),
          })),
        },
      },
      ...(opts?.internalMessageId
        ? { biz_opaque_callback_data: opts.internalMessageId }
        : {}),
    });
    return this.toResult(response, 'interactive_list');
  }

  sendCarousel(_to: E164, _payload: CarouselPayload): Promise<SendResult> {
    // See the `carousel: false` note above. When a carousel template exists it
    // belongs in the registry and goes out through sendTemplate.
    return Promise.reject(
      new WhatsappError({
        code: 'UNKNOWN',
        provider: 'cloud',
        message:
          'Carousel requires an approved carousel template; add it to the registry and send it as a template',
        providerCode: null,
      }),
    );
  }

  async sendLocation(
    to: E164,
    location: OutboundLocation,
    opts?: SendOptions,
  ): Promise<SendResult> {
    const response = await this.client.send({
      messaging_product: MESSAGING_PRODUCT,
      recipient_type: 'individual',
      to: toProviderAddress(to),
      type: 'location',
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        ...(location.name ? { name: location.name } : {}),
        ...(location.address ? { address: location.address } : {}),
      },
      ...(opts?.internalMessageId
        ? { biz_opaque_callback_data: opts.internalMessageId }
        : {}),
    });
    return this.toResult(response, 'location');
  }

  async sendReaction(
    to: E164,
    targetProviderMessageId: string,
    emoji: string,
  ): Promise<SendResult> {
    const response = await this.client.send({
      messaging_product: MESSAGING_PRODUCT,
      recipient_type: 'individual',
      to: toProviderAddress(to),
      type: 'reaction',
      reaction: { message_id: targetProviderMessageId, emoji },
    });
    return this.toResult(response, 'reaction');
  }

  async sendFlow(
    to: E164,
    payload: FlowPayload,
    opts?: SendOptions,
  ): Promise<SendResult> {
    const response = await this.client.send({
      messaging_product: MESSAGING_PRODUCT,
      recipient_type: 'individual',
      to: toProviderAddress(to),
      type: 'interactive',
      interactive: {
        type: 'flow',
        ...(payload.header
          ? { header: { type: 'text' as const, text: payload.header } }
          : {}),
        body: { text: payload.body },
        ...(payload.footer ? { footer: { text: payload.footer } } : {}),
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            ...(payload.flowToken ? { flow_token: payload.flowToken } : {}),
            flow_id: payload.flowId,
            flow_cta: payload.flowCta,
            flow_action: 'navigate',
            flow_action_payload: {
              screen: payload.screen,
              ...(payload.data ? { data: payload.data } : {}),
            },
          },
        },
      },
      ...(opts?.internalMessageId
        ? { biz_opaque_callback_data: opts.internalMessageId }
        : {}),
    });
    return this.toResult(response, 'flow');
  }

  /**
   * Read receipts and typing indicators are best-effort courtesies: a failure
   * must not surface to a caller that only wanted to show a tick. Logged and
   * swallowed, matching the Twilio provider's no-op contract.
   */
  async markAsRead(providerMessageId: string): Promise<void> {
    try {
      await this.client.markRead({
        messaging_product: MESSAGING_PRODUCT,
        status: 'read',
        message_id: providerMessageId,
      });
    } catch (err) {
      this.logger.debug(
        `markAsRead(${providerMessageId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sendTypingIndicator(providerMessageId: string): Promise<void> {
    try {
      await this.client.markRead({
        messaging_product: MESSAGING_PRODUCT,
        status: 'read',
        message_id: providerMessageId,
        typing_indicator: { type: 'text' },
      });
    } catch (err) {
      this.logger.debug(
        `sendTypingIndicator(${providerMessageId}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256 of the RAW body with the
   * app secret.
   *
   * The raw bytes matter: a JSON-reserialized body differs in key order and
   * whitespace and will never match. Compared in constant time, after a length
   * check — `timingSafeEqual` THROWS on a length mismatch rather than returning
   * false, which would turn a malformed header into a 500.
   */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string>,
  ): boolean {
    const header = headers['x-hub-signature-256'];
    if (!header?.startsWith('sha256=')) return false;

    const expected = Buffer.from(
      createHmac('sha256', this.config.appSecret).update(rawBody).digest('hex'),
      'utf8',
    );
    const received = Buffer.from(header.slice('sha256='.length), 'utf8');
    if (expected.length !== received.length) return false;
    return timingSafeEqual(expected, received);
  }

  /** Constant-time compare of the GET handshake token. */
  verifyChallengeToken(token: string): boolean {
    const expected = Buffer.from(this.config.verifyToken, 'utf8');
    const received = Buffer.from(token, 'utf8');
    if (expected.length !== received.length) return false;
    return timingSafeEqual(expected, received);
  }

  parseInboundWebhook(_body: unknown): Promise<InboundEvent[]> {
    return Promise.resolve([]);
  }
}
