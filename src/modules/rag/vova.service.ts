import { Injectable, Logger } from '@nestjs/common';
import { AccountStatus, ProfileType, VerificationStatus } from '@prisma/client';
import { SystemConfigService } from '../system-config/system-config.service';
import { bucketOf } from '../recommendation-engine/engine-rollout.service';
import {
  VovaAgentService,
  type AgentReply,
  type AnonymousAgentReply,
} from './agent/agent.service';
import {
  isAffirmation,
  isNavigationRequest,
  isAcknowledgement,
  isPureGreeting,
  offersNavigation,
} from './agent/offer';
import { VovaOfferStore } from './agent/offer.store';
import { VovaAnonymousStore } from './agent/anonymous.store';
import { VovaMemoryService } from './agent/memory.service';
import { withTimeout } from './llm/llm.service';
import { Deadline } from './llm/deadline';
import { correctSalutation, isWalled } from './agent/prompts';
import { VOVA_CONFIG_KEYS } from './vova.constants';
import { acknowledgementReply, refusal } from './agent/refusals';
import { welcomePlatformMessage } from '../bot/messages/welcome.messages';

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
  /**
   * The account status, because the assistant now answers people the bot used
   * to turn away at the door — a suspended account, a dossier under review or
   * refused.
   *
   * Without it the prompt tells everyone they are « déjà inscrite et déjà
   * connectée » and lets the model discuss applying to missions, which a
   * suspended profile cannot do. The status is what stops it saying so.
   */
  status: AccountStatus;
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
    private readonly memory: VovaMemoryService,
  ) {}

  /**
   * Log a fallen-back turn at the level it deserves.
   *
   * A turn hitting its budget is the deadline doing its job, not a fault — and
   * it was being logged at ERROR with a stack, next to real failures. The
   * classification is on the error rather than on the `Deadline` because that
   * object is scoped to the inner try; at THIS layer an `AbortError` or
   * `TimeoutError` can only have come from the turn's own budget, since every
   * provider-level abort is already converted below (`LlmService.deadlineCaused`).
   */
  private report(err: unknown, who: string): void {
    const name = err instanceof Error ? err.name : '';
    const outOfTime =
      name === 'AbortError' ||
      name === 'TimeoutError' ||
      name === 'AgentDeadlineExceededError';

    if (outOfTime) {
      this.logger.warn(
        `Vova ran out of time for ${who} ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
      return;
    }

    this.logger.error(`Vova failed for ${who}`, err);
  }

  /**
   * The doorway card, free-form.
   *
   * Delegates rather than building its own reply: this used to call
   * `templateReply('welcomePlatform', …)`, which sends the approved MARKETING
   * template. Meta bills MARKETING wherever it lands — the WABA's own figures
   * carry a `MARKETING / REGULAR` line and no free one — so every assistant
   * reply that offered to open the app was charged, months after the rest of
   * the bot had moved to the free-form card.
   */
  private card(destination: string): string {
    return welcomePlatformMessage(destination);
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

      // A bare hello, answered without a model call — and deliberately BEFORE
      // the daily allowance is consumed. Spending one of a stranger's ten
      // questions on « bonjour » would burn the budget on the one message that
      // costs us nothing to answer.
      if (isPureGreeting(text)) {
        this.logger.log(`vova.greeting anonymous phone=${phone}`);
        return { text: refusal('salutation'), offerAccount: false };
      }

      // A close, not a question — see the profile path below. Costs nothing to
      // answer, so it must not spend one of a stranger's ten questions either.
      if (isAcknowledgement(text)) {
        this.logger.log(`vova.acknowledgement anonymous phone=${phone}`);
        return { text: acknowledgementReply(null), offerAccount: false };
      }

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
      const deadline = Deadline.start(timeoutMs, 'vova-anon');

      // The outer race stays as the belt to the deadline's braces: the signal
      // is what lets each layer stop cleanly, the race is what protects the
      // WhatsApp reply if something ignores the signal entirely.
      let reply: AnonymousAgentReply;
      try {
        reply = await withTimeout(
          () =>
            this.agent.handleAnonymous({
              text,
              history,
              correlationId,
              deadline,
            }),
          timeoutMs,
          'vova-anon',
          deadline.signal,
        );
      } finally {
        // Where the turn's time actually went, emitted from the `finally` so it
        // appears exactly once however the turn ended — answered, shadowed, or
        // thrown. The catch below logs no timing at all, which is why an
        // incident that spent all 25s before the first model call left nothing
        // in the log to point at.
        //
        // `pending=` is the load-bearing half: the agent is still running when
        // this executes on a turn that lost the race, so an unfinished phase is
        // reported with its elapsed time as of right now.
        this.logger.log(
          `vova.pre phone=${phone} ${deadline.marksLine()} ms=${Date.now() - started}`,
        );

        // Not optional: without it every message leaves a live 25s timer
        // behind, and anything still running for this turn keeps going.
        deadline.dispose();
      }

      this.logger.log(
        `vova.anon phone=${phone} origin=${reply.origin} ` +
          `refusal=${reply.refusalId ?? '—'} model=${reply.telemetry?.model ?? '—'} ` +
          `turns=${history.length} blocked=[${reply.sanitizerBlocked.join('|')}] ` +
          `ms=${Date.now() - started}`,
      );

      // Written after the reply is known good, so a failed turn does not leave
      // a question in history that the next message would answer twice.
      await this.anonymous.remember(phone, text, reply.text);

      // The card follows every real answer, because the person's only next step
      // IS creating an account — the prompt already asserted as much, ending
      // every reply with « Tapez */compte* ». That instruction is now gone from
      // the prompt and the card carries it instead: same frequency, one tap
      // instead of a typed slash command.
      //
      // The greeting above stays `false` deliberately. It ends with a question
      // and hands the turn back; a card stapled to « bonjour » answers a
      // question nobody asked yet.
      return { text: reply.text, offerAccount: true };
    } catch (err) {
      this.report(err, `anonymous ${phone} — falling back to the signup card`);
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
      const [enabled, shadowRaw, percentRaw, timeoutRaw, walledLimitRaw] =
        await Promise.all([
          this.systemConfig.get(VOVA_CONFIG_KEYS.ENABLED, 'false'),
          this.systemConfig.get(VOVA_CONFIG_KEYS.SHADOW_MODE, 'true'),
          this.systemConfig.get(VOVA_CONFIG_KEYS.ROLLOUT_PERCENT, '0'),
          this.systemConfig.get(VOVA_CONFIG_KEYS.TIMEOUT_MS, '25000'),
          this.systemConfig.get(VOVA_CONFIG_KEYS.WALLED_DAILY_LIMIT, '10'),
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

      // A bare « bonjour », answered with no model call for the same reason as
      // the « oui » above — except this one is also the single largest cost
      // reduction available. A greeting routes to the standard tier (the agent
      // always binds tools, so the cheap tier is unreachable), which means a
      // 4508-token prompt and a 12-tool graph to say hello.
      //
      // Exact match only: « bonjour, combien coûte un déblocage ? » is a
      // question and must reach the model.
      if (isPureGreeting(text)) {
        this.logger.log(`vova.greeting profile=${profile.id}`);
        return shadow ? null : [refusal('salutation')];
      }

      // « merci », « non merci », « je vois », « non laisse » — the person is
      // CLOSING the exchange. Answered here, with no model call, because the
      // model kept opening a new one: a real transcript has every one of these
      // answered with "Bonjour Chloé ! Je suis VoVa AI…", a full
      // reintroduction, until she wrote « arrête avec vos messages bête la ».
      //
      // The prompt already says to answer a thank-you short and stop, and to
      // introduce itself only on the first message of a conversation. It is
      // right and the model does not reliably obey it — and this is exactly
      // the shape of question that should never have depended on obedience.
      // `isPureGreeting` above is the same trade, made for the same reason.
      if (isAcknowledgement(text)) {
        this.logger.log(`vova.acknowledgement profile=${profile.id}`);
        return shadow ? null : [acknowledgementReply(profile.first_name)];
      }

      // Meter a profile behind a wall before the model runs.
      //
      // Placed here, after the affirmation shortcut and before the call: that
      // shortcut costs nothing so it must not spend budget, while a call that
      // times out is billed all the same — which is why the counter increments
      // ahead of the model rather than after a successful reply.
      //
      // Deliberately not skipped in shadow mode. Shadow computes the reply and
      // throws it away; the tokens are spent either way, and a budget that
      // ignores the mode where nobody sees the output is a budget that misses
      // the cheapest place to overspend.
      //
      // Over budget returns null, so the bot falls back to its own card — the
      // door still opens, there is simply no more assistant today.
      if (isWalled(profile.status, profile.verification_status)) {
        const withinBudget = await this.anonymous.consumeWalled(
          profile.id,
          Number(walledLimitRaw) || 0,
        );
        if (!withinBudget) {
          this.logger.log(
            `vova.walled_limit profile=${profile.id} status=${profile.status} ` +
              `verification=${profile.verification_status}`,
          );
          return null;
        }
      }

      const timeoutMs = Number(timeoutRaw) || 25000;
      const started = Date.now();
      const deadline = Deadline.start(timeoutMs, 'vova');

      // The outer race stays as the belt to the deadline's braces: the signal
      // is what lets each layer stop cleanly, the race is what protects the
      // WhatsApp reply if something ignores the signal entirely.
      let reply: AgentReply;
      try {
        reply = await withTimeout(
          () =>
            this.agent.handle({
              profileId: profile.id,
              profileType: profile.profile_type,
              firstName: profile.first_name,
              verificationStatus: profile.verification_status,
              accountStatus: profile.status,
              // Not loaded on the hot path: the bot's profile query is shared by
              // every message, and a categories join on all of them buys one line
              // of prompt context. The agent asks `etat_du_profil` when it needs it.
              categorySlugs: [],
              text,
              correlationId,
              deadline,
            }),
          timeoutMs,
          'vova',
          deadline.signal,
        );
      } finally {
        // Where the turn's time actually went, emitted from the `finally` so it
        // appears exactly once however the turn ended — answered, shadowed, or
        // thrown. The catch below logs no timing at all, which is why an
        // incident that spent all 25s before the first model call left nothing
        // in the log to point at.
        //
        // `pending=` is the load-bearing half: the agent is still running when
        // this executes on a turn that lost the race, so an unfinished phase is
        // reported with its elapsed time as of right now.
        this.logger.log(
          `vova.pre profile=${profile.id} ${deadline.marksLine()} ms=${Date.now() - started}`,
        );

        // Not optional: without it every message leaves a live 25s timer
        // behind on the hottest path in the bot, and the work this turn
        // started keeps running after the user has been answered.
        deadline.dispose();
      }

      const elapsed = Date.now() - started;

      this.logger.log(
        `vova.reply mode=${shadow ? 'shadow' : 'live'} profile=${profile.id} ` +
          `origin=${reply.origin} refusal=${reply.refusalId ?? '—'} ` +
          `model=${reply.telemetry?.model ?? '—'} depth=${reply.telemetry?.fallbackDepth ?? '—'} ` +
          // `llm_ms` à côté de `ms` : la latence du modèle était mesurée dans
          // `LlmTelemetry` et jetée ici. Sans elle on constate 6,5 s de moyenne
          // en production sans pouvoir dire ce qui les consomme — l'appel au
          // modèle, la recherche dans le corpus, ou un second aller-retour pour
          // un outil. L'écart se lit maintenant d'un coup d'œil : `ms` moins
          // `llm_ms`, c'est tout ce qui n'est pas le modèle.
          `llm_ms=${reply.telemetry?.latencyMs ?? '—'} ` +
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

      // What this turn taught us about the person, folded in for the next one.
      //
      // Deliberately after the answer and deliberately unawaited: it is an
      // extra model call, and nobody should wait on it to be replied to. It is
      // its own claim-and-skip inside, so a long exchange rebuilds once rather
      // than once per message — and it runs on the cheap tier, off the turn's
      // deadline, because a slower better summary buys nothing here.
      // The exchange is handed over rather than looked up: neither half of it
      // is reliably in Postgres yet at this point — see `refresh`.
      void this.memory
        .refresh(profile.id, { user: text, assistant: reply.text })
        .catch((err: unknown) =>
          this.logger.debug(`memory refresh failed for ${profile.id}`, err),
        );

      // The model picks the wrong half of Bonjour/Bonsoir often enough that one
      // user corrected it himself — « Tu confond le temps c'est bonjour ah ah »,
      // at 06h08. The clock was right; the reply was not. Fixed here rather than
      // asked for again in the prompt, which has already been tried twice.
      const answer = correctSalutation(reply.text, text);

      // The card goes out now only if the person asked to go somewhere.
      // Otherwise the reply stands on its own and the destination is
      // remembered, so a following « oui » opens it.
      if (isNavigationRequest(text)) {
        return [answer, this.card(reply.destination)];
      }

      // Only remember a destination when the reply actually proposed to open
      // one. Remembering after every answer turned « oui » into « open the app »
      // even when the question had been « voulez-vous savoir à quoi sert ce
      // crédit ? » — a yes to a question about content deserves the content.
      if (offersNavigation(reply.text)) {
        await this.offers.remember(profile.id, reply.destination);
      }
      return [answer];
    } catch (err) {
      this.report(
        err,
        `profile ${profile.id} (mode=${shadow ? 'shadow' : 'live'}) — falling back`,
      );
      return null;
    }
  }
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}
