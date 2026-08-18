import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AccountStatus, BotPlatform, MessageDirection } from '@prisma/client';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import {
  WHATSAPP_PROVIDER,
  WhatsappError,
  type Capability,
  type SendResult,
  type TemplateKey,
  type TemplateParams,
  type WhatsappProvider,
} from './contracts';
import {
  welcomeActivationMessage,
  formatAdminMessage,
  flattenForTemplateVariable,
  ADMIN_MESSAGE_VAR_MAX,
} from './templates';
import {
  IdempotencyService,
  OUTBOUND_TTL_SECONDS,
  outboundKey,
} from '../../common/services/idempotency/idempotency.service';
import { outboundDuplicateBlockedCounter } from './telemetry/metrics';
import {
  WhatsappMessageLogService,
  type SendLogContext,
} from './logging/whatsapp-message-log.service';

const VERIFICATION_TOKEN_KEY_PREFIX = `${REDIS_KEY_PREFIX}wa:verify:`;

/**
 * How long the same template+params to the same number is treated as a repeat.
 *
 * The provider-agnostic safety net: whatever the upstream cause — a Meta
 * replay the worker missed, a BullMQ re-run, a bot flow that fires twice — this
 * is the last thing between it and the reader.
 *
 * Short on purpose. It is not a business rule about how often a person may be
 * messaged; it only has to span the window a duplicate realistically arrives
 * in. Anything longer starts suppressing legitimate sends.
 */
const OUTBOUND_GUARD_WINDOW_SECONDS: Partial<Record<TemplateKey, number>> = {
  // Nothing here yet. Add a template only with a reason: a longer window turns
  // a second legitimate send into silence, and the caller is told it failed.
};

/** WhatsApp's customer-service window: free-form is only allowed inside it. */
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Safety margin on the window.
 *
 * Not cosmetic. Our clock and Meta's differ, and there is real latency between
 * the admin's composer rendering, the POST landing and Twilio dispatching. Being
 * wrong towards "sent a template unnecessarily" still delivers the message;
 * being wrong the other way is the bug this whole feature exists to fix.
 */
const SERVICE_WINDOW_MARGIN_MS = 5 * 60 * 1000;

export type AdminMessageMode = 'FREE_FORM' | 'TEMPLATE';

export type AdminMessageDelivery = {
  mode: AdminMessageMode;
  sent: boolean;
  error?: string;
};

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly prisma: PrismaService,
    @Inject(WHATSAPP_PROVIDER)
    private readonly provider: WhatsappProvider,
    private readonly config: ConfigService,
    private readonly walletService: WalletService,
    private readonly idempotency: IdempotencyService,
    private readonly messageLog: WhatsappMessageLogService,
  ) {}

  isConfigured(): boolean {
    return this.provider.isConfigured();
  }

  /** Which provider is actually sending. For logs and the admin status endpoint. */
  get providerName(): WhatsappProvider['name'] {
    return this.provider.name;
  }

  /**
   * Whether the active provider can express something.
   *
   * Callers that can degrade gracefully should ask before calling rather than
   * catching `WhatsappCapabilityError` — the two providers differ most on the
   * interactive message types.
   */
  supports(capability: Capability): boolean {
    return this.provider.capabilities[capability];
  }

  /**
   * Every send here is `Promise<boolean>`: a Twilio failure is a `false`, never
   * a throw. TwilioService rethrows the SDK error (it needs the code to tell
   * 63038/63031 apart), but the ~40 call sites above this one are HTTP handlers
   * and processors that mostly `await` bare — an escaping error there turns a
   * dead sender number or a stale credential into an unhandled 500 on an
   * otherwise fine request. Callers that genuinely need the failure to surface
   * — the outbound queue processor, which relies on it for retries and the DLQ
   * — turn `false` back into a throw themselves.
   */
  private async attempt(
    what: string,
    phone: string,
    ctx: SendLogContext,
    send: (internalMessageId: string) => Promise<SendResult>,
  ): Promise<string | null> {
    try {
      return await this.logged(phone, ctx, send);
    } catch (err) {
      // An unconfigured provider is the expected state in dev and is already
      // reported by `isConfigured()`; logging it at error level on every send
      // would bury the failures that matter.
      if (err instanceof WhatsappError && err.code === 'NOT_CONFIGURED') {
        this.logger.warn(
          `WhatsApp ${what} to ${phone} skipped: ${err.message}`,
        );
        return null;
      }
      this.logger.error(
        `WhatsApp ${what} to ${phone} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * The logging half of `attempt`, with the failure left to propagate.
   *
   * Split out for `sendAdminMessage`, which must hand its error back to the
   * controller (that is what becomes the 503 telling the admin the message
   * never left). Before this existed it called the provider directly and so
   * wrote no log row at all — an admin-composed message was the one kind of
   * send that could not be traced afterwards, which is exactly the kind most
   * likely to be asked about.
   */
  private async logged(
    phone: string,
    ctx: SendLogContext,
    send: (internalMessageId: string) => Promise<SendResult>,
  ): Promise<string | null> {
    // Opened BEFORE the send, so its id can ride along as
    // `biz_opaque_callback_data` and come back on the status webhook. That is
    // the whole correlation mechanism — writing the row afterwards would leave
    // a window in which a delivery receipt arrives with nothing to attach to.
    const logId = await this.messageLog.begin(phone, ctx);

    try {
      const result = await send(logId ?? '');
      await this.messageLog.markSent(
        logId,
        result.providerMessageId,
        result.provider,
      );
      return result.providerMessageId;
    } catch (err) {
      await this.messageLog.markFailed(logId, this.provider.name, err);
      throw err;
    }
  }

  /**
   * `SendOptions` for a send, or nothing when the log row could not be opened.
   *
   * An empty id must not be forwarded: Meta echoes
   * `biz_opaque_callback_data` back verbatim, and an empty string would
   * correlate to nothing while still occupying the field.
   */
  private sendOpts(internalMessageId: string): { internalMessageId?: string } {
    return internalMessageId ? { internalMessageId } : {};
  }

  /**
   * Last line of defence against a duplicate reaching the reader.
   *
   * Sits here rather than in either provider because it must hold whichever one
   * is active, and because every send in the codebase already routes through
   * this class — so it costs no call-site changes.
   *
   * Keyed on recipient AND a hash of the parameters. Keying on the template
   * alone would block a second, genuinely different message that happens to
   * reuse it inside the window: two job recommendations a minute apart, or an
   * OTP resend the reader just asked for. Silently swallowing an authentication
   * code is a worse bug than the duplicate this prevents.
   *
   * Returns false to mean "not sent", matching what the callers already do with
   * a failed send. It does not throw: a duplicate is not an error condition,
   * and throwing here would fail a BullMQ job that has nothing left to do.
   *
   * Fails OPEN. If Redis is unreachable the message goes out — a duplicate is
   * an annoyance, silence is a broken product.
   */
  private async claimOutbound(
    phone: string,
    template: TemplateKey,
    params: unknown,
  ): Promise<boolean> {
    const ttl = OUTBOUND_GUARD_WINDOW_SECONDS[template] ?? OUTBOUND_TTL_SECONDS;
    try {
      const claimed = await this.idempotency.claim(
        outboundKey(phone, template, params),
        ttl,
      );
      if (claimed) return true;
    } catch (err) {
      this.logger.warn(
        `Outbound duplicate guard unavailable for ${template}, sending anyway: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }

    outboundDuplicateBlockedCounter.inc({ provider: this.provider.name });
    this.logger.warn(
      `Blocked duplicate ${template} to ${maskPhone(phone)}: an identical ` +
        `send was made within the last ${ttl}s`,
    );
    return false;
  }

  /**
   * Undo the guard when the send did not happen.
   *
   * The claim is taken before the send so two concurrent callers cannot both
   * dispatch, which means a failure has to hand it back — otherwise the guard
   * blocks the very retry that would have delivered the message.
   *
   * Swallows its own errors: this runs on a path that has already failed, and a
   * Redis blip here must not replace the real send error with a confusing one.
   * The key expires on its own within the window anyway.
   */
  private async releaseOutbound(
    phone: string,
    template: TemplateKey,
    params: unknown,
  ): Promise<void> {
    try {
      await this.idempotency.release(outboundKey(phone, template, params));
    } catch (err) {
      this.logger.debug(
        `Could not release the outbound guard for ${template}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sendTextMessage(
    phone: string,
    text: string,
    profileId?: string,
    sentById?: string,
  ): Promise<boolean> {
    const sid = await this.attempt(
      'text',
      phone,
      {
        kind: 'text',
        bodyPreview: text,
        profileId,
        sentById,
      },
      (logId) => this.provider.sendText(phone, text, this.sendOpts(logId)),
    );
    const sent = sid != null;

    if (sent && profileId) {
      await this.saveMessage(
        profileId,
        MessageDirection.OUTBOUND,
        text,
        sentById,
      ).catch((err) =>
        this.logger.warn(
          `Failed to save outbound message for ${profileId}:`,
          err,
        ),
      );
    }

    return sent;
  }

  async sendTemplateMessage<K extends TemplateKey>(
    phone: string,
    template: K,
    params: TemplateParams<K>,
    profileId?: string,
    body?: string,
  ): Promise<boolean> {
    // `true`, not `false`, when the guard blocks: from the caller's point of
    // view the message WAS delivered, seconds ago. The outbound processor turns
    // a false into a throw so BullMQ retries, so returning false here
    // dead-lettered jobs for the crime of correctly preventing a duplicate.
    if (!(await this.claimOutbound(phone, template, params))) return true;

    const sid = await this.attempt(
      `template ${template}`,
      phone,
      {
        kind: 'template',
        templateKey: template,
        // `body` is the human-readable rendering, and most callers pass one.
        // When they do not, the key plus the variables column still identifies
        // the message — matching what `saveMessage` writes for templates.
        bodyPreview: body ?? `[TPL:${template}]`,
        profileId,
        variables: params as Record<string, unknown> | undefined,
      },
      (logId) =>
        this.provider.sendTemplate(
          phone,
          template,
          params,
          this.sendOpts(logId),
        ),
    );
    const sent = sid != null;

    // Nothing went out, so the guard must not keep blocking. Without this the
    // three BullMQ attempts (immediate, +2s, +4s) all land inside the 60s
    // window, attempts two and three never reach the provider at all, and one
    // transient failure becomes a permanent one.
    if (!sent) await this.releaseOutbound(phone, template, params);

    if (sent && profileId && body) {
      await this.saveMessage(profileId, MessageDirection.OUTBOUND, body).catch(
        (err) =>
          this.logger.warn(
            `Failed to save outbound message for ${profileId}:`,
            err,
          ),
      );
    }

    return sent;
  }

  /**
   * MIGRATION ONLY — see `WhatsappProvider.sendTemplateWithVariables`.
   *
   * Used by the outbound processor to drain jobs enqueued before template sends
   * carried a key. New code passes typed params to `sendTemplateMessage`.
   */
  async sendTemplateMessageWithVariables(
    phone: string,
    template: TemplateKey,
    variables: Record<string, string>,
    profileId?: string,
    body?: string,
  ): Promise<boolean> {
    // See sendTemplateMessage: blocked means already delivered, not failed.
    if (!(await this.claimOutbound(phone, template, variables))) return true;

    const sid = await this.attempt(
      `template ${template}`,
      phone,
      {
        kind: 'template',
        templateKey: template,
        bodyPreview: body ?? `[TPL:${template}]`,
        profileId,
        variables,
      },
      (logId) =>
        this.provider.sendTemplateWithVariables(
          phone,
          template,
          variables,
          this.sendOpts(logId),
        ),
    );
    const sent = sid != null;

    if (!sent) await this.releaseOutbound(phone, template, variables);

    if (sent && profileId && body) {
      await this.saveMessage(profileId, MessageDirection.OUTBOUND, body).catch(
        (err) =>
          this.logger.warn(
            `Failed to save outbound message for ${profileId}:`,
            err,
          ),
      );
    }

    return sent;
  }

  /**
   * Send a WhatsApp Flow — a native in-chat form.
   *
   * `flowToken` is echoed back verbatim on submission and is the only thing
   * correlating an answer to the person who was asked, so callers must make it
   * meaningful rather than random.
   */
  async sendFeedbackFlow(
    phone: string,
    params: {
      flowId: string;
      flowToken: string;
      body: string;
      cta: string;
      profileId?: string;
    },
  ): Promise<boolean> {
    const sid = await this.attempt(
      'flow',
      phone,
      {
        kind: 'flow',
        bodyPreview: params.body,
        profileId: params.profileId,
        variables: { flowId: params.flowId, flowToken: params.flowToken },
      },
      (logId) =>
        this.provider.sendFlow(
          phone,
          {
            body: params.body,
            flowId: params.flowId,
            flowCta: params.cta,
            flowToken: params.flowToken,
            screen: 'FEEDBACK',
          },
          this.sendOpts(logId),
        ),
    );
    const sent = sid != null;

    if (sent && params.profileId) {
      await this.saveMessage(
        params.profileId,
        MessageDirection.OUTBOUND,
        params.body,
      ).catch((err) =>
        this.logger.warn(
          `Failed to save outbound flow message for ${params.profileId}:`,
          err,
        ),
      );
    }

    return sent;
  }

  async sendMediaMessage(
    phone: string,
    mediaUrl: string,
    caption?: string,
  ): Promise<boolean> {
    const sid = await this.attempt(
      'media',
      phone,
      {
        kind: 'media',
        // Mirrors the `[IMG:url] caption` form the outbound processor writes to
        // the chat transcript, so the two tables read the same way.
        bodyPreview: caption
          ? `[IMG:${mediaUrl}] ${caption}`
          : `[IMG:${mediaUrl}]`,
      },
      (logId) =>
        this.provider.sendMedia(
          phone,
          {
            kind: 'image',
            url: mediaUrl,
            caption,
          },
          this.sendOpts(logId),
        ),
    );
    return sid != null;
  }

  /**
   * Show the composer bubble against an inbound message.
   *
   * Best-effort and never throws: it is a courtesy, and a failure here must not
   * cost the reader the message it was announcing. No-ops on a provider without
   * typing support, so callers need not branch.
   */
  async showTyping(providerMessageId: string): Promise<void> {
    if (!providerMessageId || !this.provider.capabilities.typingIndicator) {
      return;
    }
    try {
      await this.provider.sendTypingIndicator(providerMessageId);
    } catch (err) {
      this.logger.debug(
        `Typing indicator for ${providerMessageId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Is the profile inside WhatsApp's 24h customer-service window?
   *
   * Free-form text is only accepted while the profile has messaged us in the
   * last 24 hours; outside it Twilio rejects with 63016. The window is derived
   * from the newest INBOUND message, which `ConversationService` writes on every
   * incoming WhatsApp message.
   *
   * NO INBOUND MESSAGE AT ALL MEANS CLOSED, and that is the common case, not an
   * edge case — most profiles sign up on the web and never message the bot.
   */
  async isServiceWindowOpen(
    profileId: string,
  ): Promise<{ open: boolean; lastInboundAt: Date | null }> {
    const last = await this.prisma.message.findFirst({
      where: {
        profile_id: profileId,
        direction: MessageDirection.INBOUND,
        // Explicit even though the column defaults to WHATSAPP: admin emails are
        // written into this same table with platform EMAIL, and an email would
        // otherwise be read as evidence of an open WhatsApp session.
        platform: BotPlatform.WHATSAPP,
      },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });

    if (!last) {
      return { open: false, lastInboundAt: null };
    }

    const age = Date.now() - last.created_at.getTime();
    return {
      open: age < SERVICE_WINDOW_MS - SERVICE_WINDOW_MARGIN_MS,
      lastInboundAt: last.created_at,
    };
  }

  /**
   * Send an admin-authored message, picking the delivery mode from the window.
   *
   * Unlike every other sender on this service, this one REPORTS ITS FAILURE
   * instead of swallowing it — see the note on `attempt` above. It has exactly
   * one caller, an admin-facing HTTP handler, and the whole point of the feature
   * is that the admin learns whether their message actually went out. So it
   * calls TwilioService directly and catches for itself.
   */
  async sendAdminMessage(params: {
    phone: string;
    profileId: string;
    message: string;
    adminUserId?: string;
  }): Promise<AdminMessageDelivery> {
    const { phone, profileId, message, adminUserId } = params;

    const { open } = await this.isServiceWindowOpen(profileId);
    const mode: AdminMessageMode = open ? 'FREE_FORM' : 'TEMPLATE';

    // Free-form keeps the admin's line breaks; the template cannot (Meta rejects
    // newlines inside a variable), so its text is flattened first. Both go
    // through the same formatter, so the two modes render identically.
    const text = open ? message.trim() : flattenForTemplateVariable(message);

    if (!text) {
      throw new BadRequestException('Le message ne peut pas être vide');
    }
    if (!open && text.length > ADMIN_MESSAGE_VAR_MAX) {
      throw new BadRequestException(
        `Hors de la fenêtre de 24h, le message est envoyé via un modèle approuvé ` +
          `et ne peut pas dépasser ${ADMIN_MESSAGE_VAR_MAX} caractères ` +
          `(actuellement ${text.length}). Découpez-le en plusieurs envois.`,
      );
    }

    const body = formatAdminMessage({ message: text });

    try {
      // Through `logged` rather than straight at the provider: this is the one
      // send an admin composes by hand, so it is the one most likely to be
      // asked about later — and it was the only one leaving no trace in the
      // delivery log, nor any `biz_opaque_callback_data` for the status webhook
      // to correlate a receipt against.
      await this.logged(
        phone,
        open
          ? {
              kind: 'text',
              bodyPreview: body,
              profileId,
              sentById: adminUserId,
            }
          : {
              kind: 'template',
              bodyPreview: body,
              templateKey: 'adminMessage',
              profileId,
              sentById: adminUserId,
              variables: { message: text },
            },
        (logId) =>
          open
            ? this.provider.sendText(phone, body, this.sendOpts(logId))
            : this.provider.sendTemplate(
                phone,
                'adminMessage',
                { message: text },
                this.sendOpts(logId),
              ),
      );
    } catch (err) {
      // An absent client is reported as "not configured" rather than as a
      // provider error — it is the one failure the admin can act on themselves.
      if (err instanceof WhatsappError && err.code === 'NOT_CONFIGURED') {
        this.logger.error(
          `Admin ${mode} message to ${phone} not sent: WhatsApp is not configured`,
        );
        return { mode, sent: false, error: 'WhatsApp n’est pas configuré' };
      }
      // The provider formats these as "[Twilio 63016] … — message to … failed",
      // which is what the admin sees in the toast.
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Admin ${mode} message to ${phone} (profile ${profileId}) failed: ${error}`,
      );
      return { mode, sent: false, error };
    }

    // Persist what was really delivered, exactly once, and only on success — a
    // bubble in the thread for a message that never arrived is the same lie as
    // returning success from the endpoint.
    await this.saveMessage(
      profileId,
      MessageDirection.OUTBOUND,
      body,
      adminUserId,
    ).catch((err) =>
      this.logger.warn(`Failed to save admin message for ${profileId}:`, err),
    );

    return { mode, sent: true };
  }

  async saveMessage(
    profileId: string,
    direction: MessageDirection,
    body: string,
    sentById?: string,
  ): Promise<void> {
    await this.prisma.message.create({
      data: {
        profile_id: profileId,
        direction,
        platform: BotPlatform.WHATSAPP,
        body,
        ...(sentById ? { sent_by_id: sentById } : {}),
      },
    });
  }

  async verifyWhatsAppToken(token: string): Promise<void> {
    if (!token || token.trim().length === 0) {
      throw new BadRequestException('Token de vérification invalide');
    }

    const redisKey = `${VERIFICATION_TOKEN_KEY_PREFIX}${token}`;
    const profileId = await this.redis.get(redisKey);

    if (!profileId) {
      throw new BadRequestException('Token de vérification invalide ou expiré');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        phone: true,
        first_name: true,
        profile_type: true,
        activated_at: true,
      },
    });

    if (!profile) {
      throw new BadRequestException('Profil introuvable');
    }

    // Preserved if already set: this is when the account opened, and a user who
    // re-verifies later has not opened a second account.
    const activatedAt = profile.activated_at;

    // Activate the account. `activated_at` records when the account became
    // usable — this path issues no session, so `last_login_at` would be a lie.
    await this.prisma.profile.update({
      where: { id: profileId },
      data: {
        whatsapp_connected: true,
        status: AccountStatus.ACTIVE,
        activated_at: activatedAt ?? new Date(),
      },
    });

    await this.redis.del(redisKey);

    // Grant welcome credit (idempotent)
    const creditAmount = await this.walletService.grantWelcomeCredit(
      profileId,
      profile.profile_type,
    );

    if (this.isConfigured()) {
      const wallet = await this.walletService
        .getOrCreateProfileWallet(profileId)
        .catch(() => ({ balance: creditAmount }));

      const message = welcomeActivationMessage(
        profile.first_name,
        creditAmount,
        profile.profile_type as 'WORKER' | 'EMPLOYER',
        wallet.balance,
      );
      await this.sendTextMessage(profile.phone, message, profileId);
    }

    this.logger.log(
      `WhatsApp verified and account activated for profile ${profileId}`,
    );
  }
}

/**
 * `+242069917686` -> `+2420***686`.
 *
 * Enough to correlate a blocked send with a support report, not enough to make
 * the log a directory of user phone numbers. Keeps the country code and the
 * last three digits, which is what someone reading the line actually needs.
 */
function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 5)}***${trimmed.slice(-3)}`;
}
