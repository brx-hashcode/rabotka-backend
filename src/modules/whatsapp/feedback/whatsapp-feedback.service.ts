import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../whatsapp.service';
import { APP_BASE_URL } from '../../bot/bot.constants';
import type { InboundEvent } from '../contracts';

/**
 * Product feedback collected through a WhatsApp Flow.
 *
 * The Flow is a native in-chat form — stars plus a comment — so the reader
 * never leaves the conversation. Its answers come back on the webhook as a
 * `flow_reply`, which is why this lives beside the inbound path rather than
 * behind an HTTP endpoint of its own.
 */
@Injectable()
export class WhatsAppFeedbackService {
  private readonly logger = new Logger(WhatsAppFeedbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsApp: WhatsAppService,
  ) {}

  private get flowId(): string | null {
    return process.env.WHATSAPP_FEEDBACK_FLOW_ID?.trim() || null;
  }

  /**
   * Ask a profile for feedback.
   *
   * Falls back to the web form where Flows are unavailable — Twilio has no
   * concept of them, and returning silently would mean feedback quietly stops
   * being collected the moment someone rolls the provider back.
   */
  async requestFeedback(phone: string, profileId: string): Promise<boolean> {
    // A Flow sent outside the 24h window is rejected (131047): it is a
    // free-form interactive message, not a template. Asking first costs one
    // indexed query and turns a failed send into the web-form fallback, which
    // is what the reader would have got anyway.
    const { open } = await this.whatsApp.isServiceWindowOpen(profileId);

    if (!open || !this.whatsApp.supports('flows') || !this.flowId) {
      return this.whatsApp.sendTextMessage(
        phone,
        [
          'Merci d’avoir utilisé Rabotka !',
          '',
          'Votre avis nous aide à améliorer le service :',
          `${APP_BASE_URL}/leave-note`,
        ].join('\n'),
        profileId,
      );
    }

    // The token is the ONLY thing tying a submission back to who was asked —
    // the reply carries no profile, and the sender's number is not on it
    // either. Stored on the row so a webhook retry cannot double-count.
    const flowToken = `fb_${profileId}_${randomUUID()}`;

    return this.whatsApp.sendFeedbackFlow(phone, {
      flowId: this.flowId,
      flowToken,
      body: 'Merci d’avoir utilisé Rabotka ! Comment s’est passée votre expérience ?',
      cta: 'Donner mon avis',
      profileId,
    });
  }

  /**
   * Persist a submitted Flow.
   *
   * Never throws: this runs on the webhook path, and a provider retries
   * anything that is not a 2xx.
   */
  async handleSubmission(
    event: Extract<InboundEvent, { kind: 'message' }>,
  ): Promise<void> {
    if (event.content.type !== 'flow_reply') return;
    const { answers, flowToken } = event.content;

    const profileId = this.profileIdFrom(flowToken);
    if (!profileId) {
      this.logger.warn(
        `Feedback submitted with no usable flow token (${flowToken ?? 'none'}) — dropped`,
      );
      return;
    }

    const score = Number(answers.score);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      this.logger.warn(
        `Feedback from ${profileId} had an out-of-range score (${String(answers.score)}) — dropped`,
      );
      return;
    }
    const comment =
      typeof answers.comment === 'string' && answers.comment.trim().length
        ? answers.comment.trim()
        : null;

    try {
      await this.prisma.feedback.create({
        data: { profile_id: profileId, score, comment, flow_token: flowToken },
      });
      this.logger.log(`Feedback ${score}/5 recorded for profile ${profileId}`);
    } catch (err) {
      // A duplicate flow_token is the expected collision: Meta retries the
      // webhook, and the unique index is what makes that harmless.
      if (isUniqueViolation(err)) {
        this.logger.debug(`Feedback ${flowToken} already recorded — ignored`);
        return;
      }
      this.logger.error(
        `Could not record feedback for ${profileId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * `fb_<profileId>_<uuid>` — the profile is the middle segment.
   *
   * Validated as a uuid before it reaches Prisma. The token is external input
   * by the time it comes back, and an id that is merely non-empty produces
   * `invalid input syntax for type uuid` from the driver — a stack trace where
   * a one-line warning belongs.
   */
  private profileIdFrom(flowToken: string | undefined): string | null {
    if (!flowToken?.startsWith('fb_')) return null;
    const withoutPrefix = flowToken.slice('fb_'.length);
    // A uuid contains dashes, so split on the LAST underscore rather than the
    // first — both halves are uuids and only the separator is unambiguous.
    const cut = withoutPrefix.lastIndexOf('_');
    if (cut <= 0) return null;
    const profileId = withoutPrefix.slice(0, cut);
    return UUID.test(profileId) ? profileId : null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'P2002'
  );
}
