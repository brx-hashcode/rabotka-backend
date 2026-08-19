import { Injectable, Logger } from '@nestjs/common';
import { ProfileType, VerificationStatus } from '@prisma/client';
import { SystemConfigService } from '../system-config/system-config.service';
import { bucketOf } from '../recommendation-engine/engine-rollout.service';
import { VovaAgentService } from './agent/agent.service';
import {
  isAffirmation,
  isNavigationRequest,
  offersNavigation,
} from './agent/offer';
import { VovaOfferStore } from './agent/offer.store';
import { VovaAnonymousStore } from './agent/anonymous.store';
import { templateReply } from '../../common/constants/whatsapp-carousel';
import { WHATSAPP_TEMPLATES } from '../../common/constants/whatsapp-templates';
import { withTimeout } from './llm/llm.service';
import { VOVA_CONFIG_KEYS } from './vova.constants';
import { refusal } from './agent/refusals';

/**
 * What the assistant said to a stranger, and whether the signup card follows.
 *
 * `offerAccount` rather than the card itself: the card belongs to the bot,
 * which already knows how to build it. Returning one from here would make the
 * fallback path depend on the assistant working, which is backwards.
 */
export interface AnonymousReply {
  text: string;
  /** Append the signup card after this message. */
  offerAccount: boolean;
}

export interface VovaBotProfile {
  id: string;
  first_name: string;
  profile_type: ProfileType;
  verification_status: VerificationStatus;
}

/**
 * The bot's door into VoVa AI.
 *
 * Returns `null` for "I did not answer this — use your own default". The
 * welcome card stays owned by the bot, which already knows how to build it;
 * having the assistant import and return it would make the fallback path
 * depend on the assistant working, which is precisely backwards.
 *
 * **Every failure returns null.** Disabled, out of bucket, shadowed, timed out,
 * thrown — the user gets exactly the reply they would have got before this
 * module existed. A WhatsApp conversation must never degrade because an
 * experiment misbehaved.
 */
@Injectable()
export class VovaService {
  private readonly logger = new Logger(VovaService.name);

  constructor(
    private readonly agent: VovaAgentService,
    private readonly systemConfig: SystemConfigService,
    private readonly offers: VovaOfferStore,
    private readonly anonymous: VovaAnonymousStore,
  ) {}

  private card(destination: string): string {
    return templateReply(
      'welcomePlatform',
      WHATSAPP_TEMPLATES.welcomePlatform.variables(destination),
    );
  }

  /**
   * Answer a number with no profile.
   *
   * Returns `null` for "not handled" exactly like `handle()`, and the caller
   * falls back to the signup card. Disabled, over budget, timed out, thrown —
   * the stranger gets the card they would have got before this existed.
   *
   * No shadow mode and no rollout bucket here. Both key off a profile id, which
   * this caller does not have; and the population is self-selecting rather than
   * a slice of existing users, so a percentage of it would mean nothing.
   * `vova.anonymous_enabled` is the whole control surface.
   */
  async handleAnonymous(
    phone: string,
    text: string,
    correlationId?: string,
  ): Promise<AnonymousReply | null> {
    try {
      const [enabled, anonymous, limitRaw, timeoutRaw] = await Promise.all([
        this.systemConfig.get(VOVA_CONFIG_KEYS.ENABLED, 'false'),
        this.systemConfig.get(VOVA_CONFIG_KEYS.ANONYMOUS_ENABLED, 'false'),
        this.systemConfig.get(VOVA_CONFIG_KEYS.ANON_DAILY_LIMIT, '10'),
        this.systemConfig.get(VOVA_CONFIG_KEYS.TIMEOUT_MS, '25000'),
      ]);

      // Both gates. The master switch still governs: turning the assistant off
      // must silence it everywhere, not leave it answering strangers.
      if (enabled !== 'true' || anonymous !== 'true') return null;

      const limit = Number(limitRaw);
      const withinBudget = await this.anonymous.consume(
        phone,
        Number.isFinite(limit) ? limit : 10,
      );
      if (!withinBudget) {
        this.logger.log(
          `vova.anon limit reached phone=${phone} limit=${limit}`,
        );
        // Told, not silently degraded. Falling back to the bare card was
        // indistinguishable from the assistant being switched off — a
        // conversation that simply stops answering reads as a fault, where a
        // stated limit is a reason to open an account.
        return { text: refusal('limite_atteinte'), offerAccount: true };
      }

      const history = await this.anonymous.history(phone);
      const timeoutMs = Number(timeoutRaw) || 25000;
      const started = Date.now();

      const reply = await withTimeout(
        () => this.agent.handleAnonymous({ text, history, correlationId }),
        timeoutMs,
        'vova-anon',
      );

      this.logger.log(
        `vova.anon phone=${phone} origin=${reply.origin} ` +
          `refusal=${reply.refusalId ?? '—'} model=${reply.telemetry?.model ?? '—'} ` +
          `turns=${history.length} blocked=[${reply.sanitizerBlocked.join('|')}] ` +
          `ms=${Date.now() - started}`,
      );

      // Written after the reply is known good, so a failed turn does not leave
      // a question in history that the next message would answer twice.
      await this.anonymous.remember(phone, text, reply.text);

      return { text: reply.text, offerAccount: false };
    } catch (err) {
      this.logger.error(
        `Vova failed for anonymous ${phone} — falling back to the signup card`,
        err,
      );
      return null;
    }
  }

  async handle(
    profile: VovaBotProfile,
    text: string,
    correlationId?: string,
  ): Promise<string[] | null> {
    let shadow = true;

    try {
      const [enabled, shadowRaw, percentRaw, timeoutRaw] = await Promise.all([
        this.systemConfig.get(VOVA_CONFIG_KEYS.ENABLED, 'false'),
        this.systemConfig.get(VOVA_CONFIG_KEYS.SHADOW_MODE, 'true'),
        this.systemConfig.get(VOVA_CONFIG_KEYS.ROLLOUT_PERCENT, '0'),
        this.systemConfig.get(VOVA_CONFIG_KEYS.TIMEOUT_MS, '25000'),
      ]);

      if (enabled !== 'true') return null;

      shadow = shadowRaw !== 'false';
      const percent = clampPercent(Number(percentRaw));

      // Stable hash, not a coin flip: a user who gets the assistant must keep
      // getting it. Alternating between an agent and a menu across messages
      // would be a worse experience than either one alone.
      if (!shadow && bucketOf(profile.id) >= percent) return null;

      // « Oui » to an offer made a moment ago. Answered without a model at
      // all: the question was already asked, the destination already chosen,
      // and making somebody wait eight seconds to be told « d'accord » is the
      // sort of thing that makes an assistant feel slow and stupid at once.
      if (isAffirmation(text)) {
        const pending = await this.offers.take(profile.id);
        if (pending) {
          this.logger.log(
            `vova.offer accepted profile=${profile.id} destination=${pending}`,
          );
          return shadow
            ? null
            : ['Voilà, c’est juste ici 👇', this.card(pending)];
        }
      }

      const timeoutMs = Number(timeoutRaw) || 25000;
      const started = Date.now();

      const reply = await withTimeout(
        () =>
          this.agent.handle({
            profileId: profile.id,
            profileType: profile.profile_type,
            firstName: profile.first_name,
            verificationStatus: profile.verification_status,
            // Not loaded on the hot path: the bot's profile query is shared by
            // every message, and a categories join on all of them buys one line
            // of prompt context. The agent asks `etat_du_profil` when it needs it.
            categorySlugs: [],
            text,
            correlationId,
          }),
        timeoutMs,
        'vova',
      );

      const elapsed = Date.now() - started;

      this.logger.log(
        `vova.reply mode=${shadow ? 'shadow' : 'live'} profile=${profile.id} ` +
          `origin=${reply.origin} refusal=${reply.refusalId ?? '—'} ` +
          `model=${reply.telemetry?.model ?? '—'} depth=${reply.telemetry?.fallbackDepth ?? '—'} ` +
          `blocked=[${reply.sanitizerBlocked.join('|')}] ms=${elapsed}`,
      );

      if (shadow) {
        // The whole point of shadow mode: the reply is judged on the log, in
        // production traffic, before a single user is shown one.
        this.logger.log(
          `vova.shadow profile=${profile.id} in=${JSON.stringify(text)} ` +
            `out=${JSON.stringify(reply.text)}`,
        );
        return null;
      }

      // The card goes out now only if the person asked to go somewhere.
      // Otherwise the reply stands on its own and the destination is
      // remembered, so a following « oui » opens it.
      if (isNavigationRequest(text)) {
        return [reply.text, this.card(reply.destination)];
      }

      // Only remember a destination when the reply actually proposed to open
      // one. Remembering after every answer turned « oui » into « open the app »
      // even when the question had been « voulez-vous savoir à quoi sert ce
      // crédit ? » — a yes to a question about content deserves the content.
      if (offersNavigation(reply.text)) {
        await this.offers.remember(profile.id, reply.destination);
      }
      return [reply.text];
    } catch (err) {
      this.logger.error(
        `Vova failed for profile ${profile.id} (mode=${shadow ? 'shadow' : 'live'}) — falling back`,
        err,
      );
      return null;
    }
  }
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}
