import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageDirection } from '@prisma/client';
import { WhatsAppService } from './whatsapp.service';
import { QueueService } from '../../common/services/queue/queue.service';
import {
  WHATSAPP_OUTBOUND_QUEUE,
  WHATSAPP_OUTBOUND_DLQ,
} from '../../common/services/queue/queue.module';
import {
  getTemplateKeyBySid,
  getUrlSuffixTargetByKey,
  type WhatsAppTemplateName,
} from '../../common/constants/whatsapp-templates';
import { WhatsAppLoginLinkService } from '../auth/whatsapp-login-link.service';

// Twilio's hard limit on a WhatsApp body is 1600 chars. We chunk well below
// that to leave room for any "(1/N)" prefix and to stay safe across UCS-2
// counting edge cases.
const WHATSAPP_BODY_LIMIT = 1500;

/** The base URL is config, so it must be escaped before going into a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Split a long string into ≤ WHATSAPP_BODY_LIMIT chunks, preferring to break
 * on blank lines, then single newlines, then spaces. Never breaks inside a
 * word unless a single word exceeds the limit (very rare).
 */
function chunkForWhatsApp(text: string): string[] {
  if (text.length <= WHATSAPP_BODY_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > WHATSAPP_BODY_LIMIT) {
    const slice = remaining.slice(0, WHATSAPP_BODY_LIMIT);
    let cut = slice.lastIndexOf('\n\n');
    if (cut < WHATSAPP_BODY_LIMIT * 0.5) cut = slice.lastIndexOf('\n');
    if (cut < WHATSAPP_BODY_LIMIT * 0.5) cut = slice.lastIndexOf(' ');
    if (cut <= 0) cut = WHATSAPP_BODY_LIMIT;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  // Prefix each with (i/N) so the reader sees ordering.
  return chunks.map((c, i) => `(${i + 1}/${chunks.length})\n${c}`);
}

/** A single WhatsApp send, without recipient (carried by the enclosing job). */
export type WhatsAppSend =
  | { type: 'text'; text: string }
  | { type: 'media'; mediaUrl: string; caption?: string }
  | {
      type: 'template';
      /** Logical template key. Provider-agnostic; what new jobs carry. */
      templateKey: WhatsAppTemplateName;
      /**
       * The resolved `{'1': …}` map, still the payload's variable form.
       *
       * Kept rather than replaced with typed params because the login-code
       * rewriting below operates on the numbered map (it has to — `urlSuffixVar`
       * names a number), and because it survives JSON round-tripping through
       * Redis without needing per-template deserialization.
       */
      contentVariables: Record<string, string>;
    }
  | {
      /**
       * LEGACY, drain-only. Jobs enqueued before template sends carried a key
       * are already sitting in Redis and cannot be rewritten, so the processor
       * accepts this shape and resolves the SID back to a key.
       *
       * Nothing produces it any more. Removable one release after this deploys,
       * once the queue has certainly drained.
       */
      type: 'template';
      contentSid: string;
      contentVariables: Record<string, string>;
    };

export type WhatsAppOutboundJobData = {
  phone: string;
  profileId?: string;
} & (
  | WhatsAppSend
  // An ordered batch delivered as ONE job: the worker runs concurrency: 3, so
  // the messages of a single bot reply (e.g. a carousel + its pagination line)
  // would otherwise race and arrive in inconsistent order. Sending them in a
  // sequence job, awaited one by one, guarantees the order the flow produced.
  | { type: 'sequence'; messages: WhatsAppSend[] }
);

@Injectable()
export class WhatsAppOutboundProcessor {
  private readonly logger = new Logger(WhatsAppOutboundProcessor.name);

  constructor(
    private readonly whatsApp: WhatsAppService,
    private readonly loginLink: WhatsAppLoginLinkService,
    private readonly config: ConfigService,
  ) {
    this.logger.debug(
      `WhatsAppOutboundProcessor constructed, whatsApp=${whatsApp?.constructor?.name ?? typeof whatsApp}`,
    );
  }

  /**
   * Called by worker.ts bootstrap to register the BullMQ worker.
   * Not using onModuleInit to avoid DI ordering issues in the worker context.
   */
  register(queueService: QueueService): void {
    const worker = queueService.createWorker<WhatsAppOutboundJobData>(
      WHATSAPP_OUTBOUND_QUEUE,
      (job) => this.process(job),
      {
        concurrency: 3,
        // Hard rate limit: max 10 Twilio sends per second across all concurrency slots.
        limiter: { max: 10, duration: 1000 },
      },
    );

    worker.on('failed', (job, err) => {
      if (!job) return;
      const maxAttempts = job.opts?.attempts ?? 3;
      if (job.attemptsMade >= maxAttempts) {
        this.logger.error(
          `Job ${job.id} permanently failed after ${job.attemptsMade} attempts: ${err.message}`,
        );
        queueService
          .addJob(WHATSAPP_OUTBOUND_DLQ, {
            originalJobId: job.id,
            data: job.data,
            error: err.message,
            failedAt: new Date().toISOString(),
          })
          .catch((dlqErr) =>
            this.logger.error(
              `Failed to move job ${job.id} to DLQ`,
              dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
            ),
          );
      }
    });
  }

  async process(job: {
    id?: string;
    data: WhatsAppOutboundJobData;
  }): Promise<void> {
    const { data } = job;
    this.logger.debug(
      `whatsApp instance: ${this.whatsApp?.constructor?.name ?? typeof this.whatsApp}`,
    );

    if (data.type === 'sequence') {
      // Await each in turn so the batch arrives in order. If a later send fails
      // the whole job retries (earlier sends may repeat) — acceptable and rare,
      // versus the alternative of guaranteed out-of-order delivery.
      for (const message of data.messages) {
        await this.processOne(data.phone, data.profileId, message);
      }
      return;
    }
    await this.processOne(data.phone, data.profileId, data);
  }

  private async processOne(
    phone: string,
    profileId: string | undefined,
    message: WhatsAppSend,
  ): Promise<void> {
    if (message.type === 'text') {
      await this.processText({ phone, profileId, ...message });
    } else if (message.type === 'media') {
      await this.processMedia({ phone, profileId, ...message });
    } else if (message.type === 'template') {
      await this.processTemplate({ phone, profileId, ...message });
    }
  }

  private async processText(
    data: Extract<WhatsAppOutboundJobData, { type: 'text' }>,
  ): Promise<void> {
    // Split any over-long body so we never hit Twilio's 1600-char hard
    // limit. For normal-sized messages this is a no-op.
    const parts = chunkForWhatsApp(
      await this.withLoginLinks(data.text, data.profileId),
    );
    for (const part of parts) {
      const sent = await this.whatsApp.sendTextMessage(
        data.phone,
        part,
        data.profileId,
      );
      if (!sent) {
        throw new Error(
          `WhatsApp text message to ${data.phone} returned no SID (unknown Twilio failure)`,
        );
      }
    }
  }

  private async processMedia(
    data: Extract<WhatsAppOutboundJobData, { type: 'media' }>,
  ): Promise<void> {
    const sent = await this.whatsApp.sendMediaMessage(
      data.phone,
      data.mediaUrl,
      data.caption,
    );
    if (!sent) {
      throw new Error(
        `WhatsApp media message to ${data.phone} returned no SID (unknown Twilio failure)`,
      );
    }
    if (data.profileId) {
      const body = data.caption
        ? `[IMG:${data.mediaUrl}] ${data.caption}`
        : `[IMG:${data.mediaUrl}]`;
      // Best-effort: the media is already delivered, so a bookkeeping failure
      // must never fail the job — a failed job is retried and would RESEND the
      // message (the recommended-profiles duplicate-card bug). Mirrors the
      // guarded save in WhatsAppService.sendTextMessage.
      await this.whatsApp
        .saveMessage(data.profileId, MessageDirection.OUTBOUND, body)
        .catch((err: unknown) =>
          this.logger.warn(
            `Failed to save outbound media message for ${data.profileId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
  }

  /**
   * Appends a one-time login code to the CTA button's URL suffix, so tapping it
   * opens the WebView already signed in instead of on the OTP screen. Every
   * content-template send funnels through here, which is why the templates
   * declare `urlSuffixVar` rather than each of the ~15 call sites doing this.
   *
   * Returns the variables untouched whenever anything is missing or fails — a
   * missing login code costs the user an OTP, a thrown error costs them the
   * notification entirely.
   */
  private async withLoginCode(
    templateKey: WhatsAppTemplateName,
    variables: Record<string, string>,
    profileId?: string,
  ): Promise<Record<string, string>> {
    const target = getUrlSuffixTargetByKey(templateKey);
    if (!profileId || !target) return variables;

    const suffix = variables[target.variable];
    if (!suffix) return variables;

    // shortlink: the variable holds the DESTINATION, and the approved URL is
    // the fixed `…/s/{{n}}` — so the code replaces it outright.
    if (target.mode === 'shortlink') {
      const code = await this.loginLink
        .mint(profileId, suffix)
        .catch(() => null);
      // No code means the profile may not auto-login (suspended) or Redis is
      // down. Leaving the destination in place would produce `/s/<path>`, a
      // dead link — so send the template as-is and let the button 404 into the
      // login fallback rather than fabricate one.
      if (!code) return variables;
      return { ...variables, [target.variable]: code };
    }

    const withCode = await this.loginLink.appendTo(
      profileId,
      suffix,
      target.separator,
    );
    if (withCode === suffix) return variables;

    return { ...variables, [target.variable]: withCode };
  }

  /**
   * Rewrites first-party links in a plain-text message into one-tap `/s/<code>`
   * links. Templates funnel through `withLoginCode`; free-form messages — every
   * Mobile Money `/pay/<token>` fallback — had no equivalent, so they always
   * cost the reader an OTP.
   *
   * Left alone: wa.me (not ours), `/r/<hash>` ad links (already tracked and
   * resolved server-side) and `/verify/whatsapp` (carries its own token, and the
   * account is not ACTIVE yet so no code would be minted anyway).
   */
  private async withLoginLinks(
    text: string,
    profileId?: string,
  ): Promise<string> {
    if (!profileId) return text;

    const base = (
      this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    if (!text.includes(base)) return text;

    const urls = [
      ...new Set(
        text.match(new RegExp(`${escapeRegExp(base)}[^\\s<>"')\\]}]*`, 'g')) ??
          [],
      ),
    ].filter((url) => {
      const path = url.slice(base.length);
      return !/^\/(r|verify|s)\//.test(path) && path !== '' && path !== '/';
    });

    let rewritten = text;
    for (const url of urls) {
      const link = await this.loginLink
        .shortLink(profileId, url.slice(base.length))
        .catch(() => null);
      if (link) rewritten = rewritten.split(url).join(link);
    }

    return rewritten;
  }

  private async processTemplate(
    data: Extract<WhatsAppOutboundJobData, { type: 'template' }>,
  ): Promise<void> {
    // New jobs carry the logical key. A job enqueued before this deploy carries
    // a Twilio SID instead and is resolved back — that payload is already in
    // Redis and cannot be rewritten.
    const key =
      'templateKey' in data
        ? data.templateKey
        : getTemplateKeyBySid(data.contentSid);
    if (!key) {
      throw new Error(
        `WhatsApp template ${'contentSid' in data ? data.contentSid : '?'} to ${data.phone} ` +
          `has no registry entry — the SID was removed or an env override points ` +
          `at an unknown template`,
      );
    }

    const sent = await this.whatsApp.sendTemplateMessageWithVariables(
      data.phone,
      key,
      await this.withLoginCode(key, data.contentVariables, data.profileId),
    );
    if (!sent) {
      throw new Error(
        `WhatsApp template ${key} to ${data.phone} returned no SID (unknown provider failure)`,
      );
    }
    if (data.profileId) {
      // Best-effort: the template is already delivered, so a bookkeeping
      // failure must never fail the job — a failed job is retried and would
      // RESEND the message (the recommended-profiles duplicate-card bug).
      // Mirrors the guarded save in WhatsAppService.sendTextMessage.
      await this.whatsApp
        .saveMessage(data.profileId, MessageDirection.OUTBOUND, `[TPL:${key}]`)
        .catch((err: unknown) =>
          this.logger.warn(
            `Failed to save outbound template message for ${data.profileId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
  }
}
