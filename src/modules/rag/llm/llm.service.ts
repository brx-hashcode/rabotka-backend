import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseMessage, type AIMessage } from '@langchain/core/messages';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
import { LlmBreakerService } from './breaker.service';
import { readNumber } from '../shared/config';
import { LlmModelFactory } from './model-factory.service';
import {
  PROVIDER_API_KEY_ENV,
  PROVIDERS_REQUIRING_FLAT_CONTENT,
  PROVIDERS_SUPPORTING_CACHE_CONTROL,
  resolveChain,
} from './models.config';
import {
  classifyLlmError,
  isRetryableInPlace,
  shouldTripBreaker,
  type LlmErrorClass,
} from './error-classification';
import {
  LlmChainExhaustedError,
  LlmDeadlineExceededError,
  LlmFatalError,
  LlmNoProviderError,
} from './llm.errors';
import { Deadline } from './deadline';
import {
  specId,
  type LlmCallTelemetry,
  type LlmInvokeResult,
  type LlmProviderSpec,
  type LlmTier,
} from './llm.types';
import {
  llmCacheReadTokenCounter,
  llmChainPositionGauge,
  llmFallbackCounter,
  llmHealthScoreGauge,
  llmInputTokenCounter,
  llmLatencyHistogram,
  llmRequestCounter,
  type LlmRequestStatus,
} from './metrics';

export interface LlmInvokeOptions {
  tier: LlmTier;
  /** Bound with `bindTools` when present. A provider without tool support fails fatal. */
  tools?: BindToolsInput[];
  /** Per-attempt CEILING. The deadline can lower it; it can never raise it. */
  timeoutMs?: number;
  /** `requestIdMiddleware`'s id, so one conversation is greppable end to end. */
  correlationId?: string;
  /**
   * The turn's wall-clock budget. Per-call timeouts are clamped inside it, so a
   * fallback always has room to run — see {@link Deadline}.
   */
  deadline?: Deadline;
  /**
   * Cancels THIS call only: LangGraph's per-run signal, or a raced run's own
   * controller. Combined with the deadline rather than replacing it.
   */
  signal?: AbortSignal;
  /**
   * How much of the budget to hold back for whoever runs after this call.
   *
   * `undefined` means the service's default reserve. `0` means "I am the last
   * provider — there is nobody left to save time for", which only the caller
   * walking the chain can know.
   */
  reserveMs?: number;
}

/**
 * Runs a tier's provider chain in order.
 *
 * **Why not `Runnable.withFallbacks`** — it catches every error and advances
 * unconditionally (`@langchain/core/dist/runnables/base.cjs`); the JS port has
 * no equivalent of Python's `exceptions_to_handle`. That makes the two rules
 * this platform actually needs inexpressible: never burn three vendors on a
 * malformed request, and never shop for a provider that will answer something
 * another one's safety layer refused. It also reports the *first* error rather
 * than the last, and cannot skip a provider the breaker has already opened.
 * LangChain still owns everything above this line — the models, tool binding,
 * and the LangGraph agent that calls us.
 */
/**
 * How close to the end still counts as "the turn ran out of time".
 *
 * Zero is too strict, and the race it misses is the one the comment in
 * `deadlineCaused` describes: when the reserve is released the per-call budget
 * EQUALS the remaining turn, so both timers are armed for the same instant.
 * If the per-call timer lands a fraction of a millisecond first, `expired()`
 * was still false — `remainingMs()` returned 1 — and a healthy provider took
 * the blame for the turn running out.
 *
 * It surfaced as a flaky test (`gives up at the turn deadline rather than at
 * the per-call cap` failing with `LlmChainExhaustedError` on a loaded CI
 * runner), but the flake was reporting a real misclassification: in production
 * the same tie records a failure against a vendor that did nothing wrong, and
 * `shouldTripBreaker('transport')` is true.
 *
 * Two milliseconds, because no model call completes in that window — anything
 * that "finished" there finished because a timer fired, not because a provider
 * answered.
 */
const DEADLINE_TIE_MS = 2;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly defaultTimeoutMs: number;
  /** Pause before the single retry a 5xx earns. */
  private readonly retryBackoffMs: number;
  /** Budget held back so a fallback is reachable inside the SAME turn. */
  private readonly fallbackReserveMs: number;
  /** Below this, a call is not "short" — it is a guaranteed timeout that bills tokens. */
  private readonly minCallMs: number;
  /** Config warnings already emitted, so a permanent problem is logged once. */
  private readonly warned = new Set<string>();

  private readonly healthEnabled: boolean;
  /** Assumed latency for a provider with no recent traffic. */
  private readonly healthDefaultMs: number;
  private readonly healthPrior: number;
  private readonly healthMinGainRatio: number;

  constructor(
    private readonly factory: LlmModelFactory,
    private readonly breaker: LlmBreakerService,
    config: ConfigService,
  ) {
    // 12000, down from 20000, and the change is arithmetic rather than taste:
    // against a 25000ms turn budget, a 20000ms per-call cap left 5000ms for
    // everything else, so the second provider could not run at all. See
    // `budgetFor` — this is now a CEILING that the deadline routinely lowers.
    this.defaultTimeoutMs = readNumber(config, 'VOVA_LLM_TIMEOUT_MS', 12000);
    this.retryBackoffMs = readNumber(config, 'VOVA_LLM_RETRY_BACKOFF_MS', 250);
    this.fallbackReserveMs = readNumber(
      config,
      'VOVA_FALLBACK_RESERVE_MS',
      7000,
    );
    this.minCallMs = readNumber(config, 'VOVA_LLM_MIN_CALL_MS', 1500);

    // Ships dark. The scoreboard is written from the first deploy so the gauges
    // have real data to look at, but nothing reorders until this is turned on —
    // a chain that rearranges itself is not something to debug for the first
    // time during an incident.
    this.healthEnabled = config.get<string>('VOVA_HEALTH_ENABLED') === 'true';
    this.healthDefaultMs = readNumber(config, 'VOVA_HEALTH_DEFAULT_MS', 4000);
    this.healthPrior = readNumber(config, 'VOVA_HEALTH_PRIOR', 3);
    this.healthMinGainRatio = readNumber(
      config,
      'VOVA_HEALTH_MIN_GAIN_RATIO',
      1.25,
    );
  }

  /**
   * What this call may spend, given what the turn has left.
   *
   * The reserve is WITHHELD while somebody remains to fall over to, and
   * RELEASED once nobody does — a last provider holding time back for a
   * successor that does not exist would throw away the turn's final chance at
   * an answer. Which case applies is known to the caller walking the chain, not
   * here, so it arrives as `reserveMs`.
   */
  private budgetFor(options: LlmInvokeOptions): number {
    const cap = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!options.deadline) return cap;

    const remaining = options.deadline.remainingMs();
    const reserve = options.reserveMs ?? this.fallbackReserveMs;
    const usable = remaining - reserve;

    if (usable >= this.minCallMs) return Math.min(cap, usable);

    // Not enough room once the reserve is taken out. Spend what is actually
    // left rather than nothing — but only if it could plausibly complete.
    if (remaining >= this.minCallMs) return Math.min(cap, remaining);

    throw new LlmDeadlineExceededError(
      `no budget left for a model call (${remaining}ms remains, ` +
        `${this.minCallMs}ms is the floor)`,
      {
        tier: options.tier,
        provider: null,
        model: null,
        fallbackDepth: 0,
        latencyMs: 0,
        attempts: 0,
        breakerSkipped: [],
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
      },
    );
  }

  /**
   * The tier's chain, minus providers whose breaker is open.
   *
   * Exposed because failover has to happen per *conversation*, not per call.
   * Gemini 3.x carries a `thought_signature` inside its tool history and
   * rejects a history another vendor produced — so swapping providers midway
   * through an agent run corrupts it. The agent picks one provider, runs the
   * whole loop on it, and only then tries the next.
   */
  async usableChain(tier: LlmTier): Promise<LlmProviderSpec[]> {
    // Two gates, and both matter once runs are raced.
    //
    // `resolveChain` filters on `process.env`; the factory filters on the
    // `ConfigService` it will actually read when building. They are normally
    // the same values, but ConfigService is cached at boot and runs
    // `expandVariables`, so they CAN drift — and a provider that passes the
    // first and fails the second throws a plain Error from `build`, which
    // classifies as `transport` and opens that provider's breaker for what is
    // our own misconfiguration. Racing would repeat that on every turn.
    const chain = resolveChain(tier).filter((spec) => {
      if (this.factory.hasCredential(spec)) return true;
      this.warnOnce(
        `${specId(spec)} is in the ${tier} chain and has an env var set, but ` +
          `ConfigService has no value for ${PROVIDER_API_KEY_ENV[spec.provider]} — ` +
          `excluding it. Check .env.local/.env and ConfigModule's envFilePath.`,
      );
      return false;
    });

    const open = await Promise.all(chain.map((s) => this.breaker.isOpen(s)));
    const usable = chain.filter((_, i) => !open[i]);

    return this.healthEnabled ? await this.orderByHealth(usable) : usable;
  }

  /**
   * Promote a provider past the one ahead of it, but only decisively.
   *
   * NOT a free sort by score. `models.config.ts` argues at length for why each
   * entry sits where it does, and re-sorting on noise would quietly discard all
   * of it — a provider 5% faster this minute is not evidence of anything. The
   * static order stays the default and this is an override for outliers: one
   * bubble pass, promoting only past `VOVA_HEALTH_MIN_GAIN_RATIO`.
   *
   * The score is expected latency — observed latency divided by success rate —
   * so a fast provider that fails a third of its calls ranks below a steady
   * slower one, which is the trade a WhatsApp budget actually wants.
   */
  private async orderByHealth(
    chain: LlmProviderSpec[],
  ): Promise<LlmProviderSpec[]> {
    if (chain.length < 2) return chain;

    const health = await this.breaker.health(chain);
    if (health.size === 0) return chain;

    const scoreOf = (spec: LlmProviderSpec): number => {
      const h = health.get(specId(spec));
      const latency = h?.ewmaMs ?? this.healthDefaultMs;
      // Beta smoothing with a prior, so one lucky sample cannot promote an
      // unproven provider to the head of the chain.
      const ok = h?.ok ?? 0;
      const fail = h?.fail ?? 0;
      const p = (ok + this.healthPrior) / (ok + fail + 2 * this.healthPrior);
      const score = latency / Math.max(p, 0.05);

      llmHealthScoreGauge.set(
        { provider: spec.provider, model: spec.model },
        score,
      );
      return score;
    };

    const ordered = [...chain];
    for (let i = 1; i < ordered.length; i++) {
      if (
        scoreOf(ordered[i]) * this.healthMinGainRatio <
        scoreOf(ordered[i - 1])
      ) {
        const promoted = ordered[i];
        this.logger.debug(
          `Promoting ${specId(promoted)} ahead of ${specId(ordered[i - 1])} ` +
            `on observed health`,
        );
        ordered[i] = ordered[i - 1];
        ordered[i - 1] = promoted;
      }
    }

    ordered.forEach((spec, position) => {
      llmChainPositionGauge.set(
        { provider: spec.provider, model: spec.model },
        position,
      );
    });

    return ordered;
  }

  /** Config problems are permanent; logging one per message would bury them. */
  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.logger.warn(message);
  }

  /** One provider, no chain. The retry and timeout rules still apply. */
  async invokeWith(
    spec: LlmProviderSpec,
    input: BaseLanguageModelInput,
    options: LlmInvokeOptions,
  ): Promise<LlmInvokeResult<AIMessage>> {
    const startedAt = Date.now();
    const telemetry: LlmCallTelemetry = {
      tier: options.tier,
      provider: spec.provider,
      model: spec.model,
      fallbackDepth: 0,
      latencyMs: 0,
      attempts: 0,
      breakerSkipped: [],
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
    };

    try {
      const output = await this.callWithRetry(spec, input, options, telemetry);
      telemetry.latencyMs = Date.now() - startedAt;
      // Latency is handed over here, on the ONE path where the call actually
      // succeeded — a failure's duration must never reach the moving average.
      await this.breaker.recordSuccess(spec, telemetry.latencyMs);
      this.readUsage(output, telemetry);
      this.log(telemetry, options.correlationId, 'ok');
      return { output, telemetry };
    } catch (err) {
      const cls = classifyLlmError(err);
      telemetry.latencyMs = Date.now() - startedAt;

      // The turn running out of time is OUR budget expiring, not the vendor
      // misbehaving — and `classifyLlmError` cannot tell the two aborts apart,
      // since both surface as AbortError/TimeoutError and both classify as
      // `transport`, which trips the breaker.
      //
      // Left unhandled, a slow afternoon would record a failure against every
      // provider still in flight when its turn expired, and five such turns
      // open a breaker on a vendor that never failed once. That is a
      // self-inflicted outage built out of healthy providers, so a
      // deadline-caused abort is logged as its own outcome and touches neither
      // the breaker nor the failure counters.
      if (this.deadlineCaused(err, options)) {
        this.log(telemetry, options.correlationId, 'deadline');
        throw err instanceof LlmDeadlineExceededError
          ? err
          : new LlmDeadlineExceededError(
              `${specId(spec)} did not finish inside the turn budget (${describe(err)})`,
              telemetry,
              err,
            );
      }

      if (shouldTripBreaker(cls)) await this.breaker.recordFailure(spec);
      this.log(
        telemetry,
        options.correlationId,
        cls === 'fatal' ? 'fatal' : 'exhausted',
      );
      throw cls === 'fatal'
        ? new LlmFatalError(
            `${specId(spec)} failed fatally (${describe(err)})`,
            telemetry,
            err,
          )
        : new LlmChainExhaustedError(
            `${specId(spec)} failed (${cls}: ${describe(err)})`,
            telemetry,
            err,
          );
    }
  }

  async invoke(
    input: BaseLanguageModelInput,
    options: LlmInvokeOptions,
  ): Promise<LlmInvokeResult<AIMessage>> {
    const startedAt = Date.now();
    const chain = resolveChain(options.tier);
    const telemetry: LlmCallTelemetry = {
      tier: options.tier,
      provider: null,
      model: null,
      fallbackDepth: 0,
      latencyMs: 0,
      attempts: 0,
      breakerSkipped: [],
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
    };

    if (chain.length === 0) {
      telemetry.latencyMs = Date.now() - startedAt;
      // Counted, though nothing is logged here — the error carries the message
      // and the caller decides how loud to be. Without this the series simply
      // stops during a total misconfiguration, which reads on a dashboard as
      // "no traffic" rather than "answering nobody".
      this.record(telemetry, 'exhausted');
      throw new LlmNoProviderError(
        `Tier "${options.tier}" has no provider with a credential configured`,
        telemetry,
      );
    }

    let firstError: unknown;

    for (const spec of chain) {
      if (await this.breaker.isOpen(spec)) {
        telemetry.breakerSkipped.push(specId(spec));
        telemetry.fallbackDepth += 1;
        continue;
      }

      try {
        const output = await this.callWithRetry(
          spec,
          input,
          options,
          telemetry,
        );
        await this.breaker.recordSuccess(spec);

        telemetry.provider = spec.provider;
        telemetry.model = spec.model;
        telemetry.latencyMs = Date.now() - startedAt;
        this.readUsage(output, telemetry);
        this.log(telemetry, options.correlationId, 'ok');
        return { output, telemetry };
      } catch (err) {
        const cls = classifyLlmError(err);
        firstError ??= err;

        if (cls === 'fatal') {
          // Deliberately does NOT touch the breaker: a 400 or a 401 is our
          // misconfiguration, and pulling a healthy vendor out of rotation for
          // it would hide the bug behind an outage.
          telemetry.provider = spec.provider;
          telemetry.model = spec.model;
          telemetry.latencyMs = Date.now() - startedAt;
          this.log(telemetry, options.correlationId, 'fatal');
          throw new LlmFatalError(
            `${specId(spec)} failed fatally (${describe(err)}) — not falling over`,
            telemetry,
            err,
          );
        }

        if (shouldTripBreaker(cls)) await this.breaker.recordFailure(spec);
        // Counted here rather than at the top of the next iteration, because
        // the LAST provider in the chain also fails over — to nothing. Skipping
        // it would silently under-count the failure that matters most.
        llmFallbackCounter.inc({
          from: spec.provider,
          to: chain[chain.indexOf(spec) + 1]?.provider ?? 'none',
          reason: cls,
        });
        this.logger.warn(
          `${specId(spec)} failed (${cls}: ${describe(err)}) — advancing`,
        );
        telemetry.fallbackDepth += 1;
      }
    }

    telemetry.latencyMs = Date.now() - startedAt;
    this.log(telemetry, options.correlationId, 'exhausted');
    throw new LlmChainExhaustedError(
      `Every provider in tier "${options.tier}" failed or was skipped`,
      telemetry,
      firstError,
    );
  }

  /** One provider, with the single in-place retry a 5xx earns. */
  private async callWithRetry(
    spec: LlmProviderSpec,
    input: BaseLanguageModelInput,
    options: LlmInvokeOptions,
    telemetry: LlmCallTelemetry,
  ): Promise<AIMessage> {
    let lastError: unknown;
    let cls: LlmErrorClass = 'transport';

    for (let attempt = 0; attempt < 2; attempt++) {
      telemetry.attempts += 1;
      try {
        return await this.callOnce(spec, input, options);
      } catch (err) {
        lastError = err;
        cls = classifyLlmError(err);
        if (!isRetryableInPlace(cls)) break;
        if (attempt === 0) {
          // A retry that cannot finish is worse than an immediate failover: it
          // spends the backoff, bills a prompt, and hands the next provider a
          // budget too small to use.
          const left = options.deadline?.remainingMs();
          if (
            left !== undefined &&
            left < this.retryBackoffMs + this.minCallMs
          ) {
            this.logger.debug(
              `${specId(spec)} returned a server error — skipping the retry, ` +
                `only ${left}ms left in the turn`,
            );
            break;
          }

          this.logger.debug(
            `${specId(spec)} returned a server error — one retry in ${this.retryBackoffMs}ms`,
          );
          await sleep(this.retryBackoffMs);
        }
      }
    }

    throw lastError;
  }

  private async callOnce(
    spec: LlmProviderSpec,
    input: BaseLanguageModelInput,
    options: LlmInvokeOptions,
  ): Promise<AIMessage> {
    // Budget FIRST, before the model is built.
    //
    // `factory.build` is not free on a cold provider: it dynamically imports
    // the vendor SDK and constructs an HTTP client, which is tens of MB and
    // hundreds of milliseconds the first time. Paying that to then discover
    // there is no time left is the exact waste this check exists to prevent —
    // and it is worst precisely when things are already going badly, which is
    // when a cold provider gets reached at all.
    const budget = this.budgetFor(options);

    const model = await this.factory.build(spec);
    let runnable: Runnable<BaseLanguageModelInput, AIMessage>;

    if (options.tools?.length) {
      if (typeof model.bindTools !== 'function') {
        // Fatal on purpose: falling over to another provider would answer a
        // tool-shaped question with prose, which is worse than failing.
        throw new TypeError(
          `${specId(spec)} does not support tool calling — remove it from a tier that binds tools`,
        );
      }
      runnable = model.bindTools(options.tools) as Runnable<
        BaseLanguageModelInput,
        AIMessage
      >;
    } else {
      runnable = model;
    }

    // Two independent reasons to stop: the turn ran out of time, or this
    // particular run was cancelled (LangGraph aborting the graph, or a raced
    // run losing). Either must reach the SDK, so they are combined rather than
    // one winning over the other.
    const outer =
      options.deadline && options.signal
        ? AbortSignal.any([options.deadline.signal, options.signal])
        : (options.signal ?? options.deadline?.signal);

    return withTimeout(
      (signal) => runnable.invoke(this.shapeFor(spec, input), { signal }),
      budget,
      specId(spec),
      outer,
    );
  }

  /**
   * The one place a provider's content quirks are applied.
   *
   * Both rules are mutually exclusive by construction: a provider that needs
   * flat text cannot carry a cache breakpoint, because flattening is what
   * destroys the block the breakpoint lives on.
   */
  private shapeFor<T>(spec: LlmProviderSpec, input: T): T {
    if (PROVIDERS_REQUIRING_FLAT_CONTENT.has(spec.provider)) {
      return flattenContent(input);
    }
    if (PROVIDERS_SUPPORTING_CACHE_CONTROL.has(spec.provider)) {
      return markCacheBreakpoint(input);
    }
    return input;
  }

  private readUsage(output: AIMessage, telemetry: LlmCallTelemetry): void {
    const usage = output.usage_metadata;
    telemetry.inputTokens = usage?.input_tokens ?? null;
    telemetry.outputTokens = usage?.output_tokens ?? null;
    telemetry.cacheReadTokens = usage?.input_token_details?.cache_read ?? null;
  }

  /**
   * The same telemetry, as Prometheus series.
   *
   * Called from `log()` because that is already the single point every call
   * passes through on its way out, whichever way it ended — a second call site
   * would eventually miss a branch and under-report exactly the failures the
   * metric exists to catch.
   *
   * `provider`/`model` are null when the tier had nothing usable to try, and
   * `none` keeps the label present rather than dropping the series: "we failed
   * without reaching anybody" is itself worth alerting on.
   */
  private record(t: LlmCallTelemetry, outcome: LlmRequestStatus): void {
    const provider = t.provider ?? 'none';
    const model = t.model ?? 'none';

    llmRequestCounter.inc({
      provider,
      model,
      tier: t.tier,
      status: outcome,
    });
    llmLatencyHistogram.observe(
      { provider, model, tier: t.tier },
      t.latencyMs / 1000,
    );
    if (t.inputTokens !== null) {
      llmInputTokenCounter.inc({ provider, model }, t.inputTokens);
    }
    if (t.cacheReadTokens !== null) {
      llmCacheReadTokenCounter.inc({ provider, model }, t.cacheReadTokens);
    }
  }

  /**
   * One line per call, in the shape an incident is actually read in. A rising
   * `depth` is the earliest signal a provider is degrading, and it is invisible
   * in latency alone.
   */
  private log(
    t: LlmCallTelemetry,
    correlationId: string | undefined,
    outcome: LlmRequestStatus,
  ): void {
    this.record(t, outcome);

    const parts = [
      `outcome=${outcome}`,
      `tier=${t.tier}`,
      `model=${t.model ? `${t.provider}/${t.model}` : 'none'}`,
      `depth=${t.fallbackDepth}`,
      `attempts=${t.attempts}`,
      `latency_ms=${t.latencyMs}`,
    ];
    if (t.breakerSkipped.length) {
      parts.push(`breaker_skipped=${t.breakerSkipped.join('|')}`);
    }
    if (t.inputTokens !== null || t.outputTokens !== null) {
      parts.push(`tokens_in=${t.inputTokens ?? '?'}`);
      parts.push(`tokens_out=${t.outputTokens ?? '?'}`);
    }
    // Only where the provider reports it, so the field's absence stays
    // meaningful: a missing `cache_read` is "this vendor does not cache", while
    // `cache_read=0` on every turn is the prompt split having stopped working.
    if (t.cacheReadTokens !== null) {
      parts.push(`cache_read=${t.cacheReadTokens}`);
    }
    if (correlationId) parts.push(`request_id=${correlationId}`);

    const line = `vova.llm ${parts.join(' ')}`;
    if (outcome === 'ok') this.logger.log(line);
    // A turn running out of budget is a capacity fact, not a provider fault.
    // Logging it at ERROR next to real failures is what would make an alert on
    // this series mean two different things at once.
    else if (outcome === 'deadline') this.logger.warn(line);
    else this.logger.error(line);
  }

  /**
   * Did OUR cancellation end this call, rather than the provider failing?
   *
   * Covers both cancels: the turn deadline expiring, and this run being
   * abandoned deliberately (LangGraph aborting the graph, or a raced run losing
   * to a faster one). Neither is evidence about the vendor, so neither may
   * reach the breaker.
   */
  private deadlineCaused(err: unknown, options: LlmInvokeOptions): boolean {
    if (err instanceof LlmDeadlineExceededError) return true;
    if (options.signal?.aborted === true) return true;
    if (!options.deadline) return false;

    // `causedAbort()` alone is not enough, and the gap is not hypothetical.
    // On the LAST provider the reserve is released, so its per-call budget
    // equals the whole remaining turn — both timers then fire in the same
    // millisecond and whichever lands first decides whether a healthy vendor
    // takes the blame. Asking "is the turn out of time?" instead of "did the
    // turn's timer win the race?" makes that deterministic.
    //
    // It errs toward not blaming the provider. That asymmetry is deliberate:
    // failing to open a breaker costs one slow call, while opening one on a
    // healthy vendor removes it from the chain for a full cooldown.
    return (
      options.deadline.causedAbort() ||
      options.deadline.remainingMs() <= DEADLINE_TIE_MS
    );
  }
}

/**
 * Rewrites array-shaped message content as plain text.
 *
 * Providers disagree about content blocks. Gemini returns an assistant turn
 * whose `content` is `[{type:"text",…}]`, and handing that history back to
 * Mistral fails with «only supports types "text" or "image_url" for complex
 * message types» — so the fallback chain worked on the first turn of a
 * conversation and broke on every turn after a tool call, which is the moment
 * failover matters most.
 *
 * Applied ONLY to providers in `PROVIDERS_REQUIRING_FLAT_CONTENT`. Doing it
 * globally looked tidier and was wrong: Gemini 3.x carries a
 * `thought_signature` inside those blocks and rejects a flattened history with
 * «Function call is missing a thought_signature», so the fix for one provider
 * is a 400 for the other.
 *
 * Flattening is safe for the providers that need it because Vova is text-only:
 * there is no image or audio part to lose. Messages are copied rather than
 * mutated — LangGraph keeps its own reference to the history, and rewriting it
 * in place would corrupt the conversation for every later provider too.
 */
export function flattenContent<T>(input: T): T {
  if (!Array.isArray(input)) return input;

  return input.map((message) => {
    if (!(message instanceof BaseMessage) || !Array.isArray(message.content)) {
      return message;
    }

    const text = message.content
      .map((part) =>
        typeof part === 'string'
          ? part
          : ((part as { text?: unknown }).text ?? ''),
      )
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join('\n');

    const copy = Object.assign(
      Object.create(Object.getPrototypeOf(message) as object),
      message,
    ) as BaseMessage;
    copy.content = text;
    return copy;
  }) as T;
}

/**
 * Marks the end of the cacheable prefix on the system message.
 *
 * `agent.service.ts` hands the system prompt over as two blocks — stable, then
 * volatile — and this puts `cache_control` on the first one. Everything the API
 * renders before that point is cached with it, and since the layout is
 * `tools → system → messages`, that includes the tool schemas: ~1.3k tokens of
 * them, on top of ~2.7k of stable prompt.
 *
 * Only the FIRST block, and only on the system message. A breakpoint on the
 * volatile block would cache a prefix that changes every turn, which writes a
 * new cache entry per message — the expensive half of caching with none of the
 * saving.
 *
 * Messages are copied rather than mutated, for the same reason `flattenContent`
 * copies: LangGraph holds its own reference to this history, and writing a
 * provider-specific key into it would leak Anthropic's wire format into the
 * turn every other provider sees on the next attempt.
 */
export function markCacheBreakpoint<T>(input: T): T {
  if (!Array.isArray(input)) return input;

  let marked = false;
  return input.map((message) => {
    if (
      marked ||
      !(message instanceof BaseMessage) ||
      message.getType() !== 'system' ||
      !Array.isArray(message.content) ||
      message.content.length === 0
    ) {
      return message;
    }

    const [first, ...rest] = message.content;
    if (typeof first !== 'object' || first === null) return message;

    marked = true;
    const copy = Object.assign(
      Object.create(Object.getPrototypeOf(message) as object),
      message,
    ) as BaseMessage;
    copy.content = [
      { ...first, cache_control: { type: 'ephemeral' } },
      ...rest,
    ] as typeof message.content;
    return copy;
  }) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Aborts the provider call at the deadline AND stops waiting on it.
 *
 * Both halves are needed: the signal is what lets a well-behaved SDK cancel its
 * HTTP request, and the race is what protects the WhatsApp reply budget from an
 * SDK that ignores the signal. The loser's rejection is swallowed explicitly —
 * without that, an abort that lands after the race resolves surfaces as an
 * unhandled rejection and, under Nest's default, can take the process down.
 *
 * `externalSignal` is the turn's deadline (and, once runs are raced, the
 * per-run cancel). It gets the same treatment as the local timer for the same
 * reason: cancelling the HTTP request is not enough on its own if the SDK never
 * settles the promise.
 */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let detach: (() => void) | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);
  });

  const races: Promise<T>[] = [timeout];

  if (externalSignal) {
    races.push(
      new Promise<never>((_, reject) => {
        const fail = () => {
          const err = new Error(`${label} aborted before it finished`);
          err.name = 'AbortError';
          reject(err);
        };

        if (externalSignal.aborted) return fail();

        externalSignal.addEventListener('abort', fail, { once: true });
        // Not optional. This function runs once per model call — up to
        // `recursionLimit` times per graph run, doubled again when two runs are
        // raced — while the deadline's signal lives for the whole turn. Leaving
        // the listeners attached leaks a closure per call and trips Node's
        // MaxListenersExceededWarning on a busy turn.
        detach = () => externalSignal.removeEventListener('abort', fail);
      }),
    );
  }

  // `AbortSignal.any` composites are weakly held from Node 20.5, so this one
  // needs none of the cleanup care the listener above does.
  const call = run(
    externalSignal
      ? AbortSignal.any([controller.signal, externalSignal])
      : controller.signal,
  );
  call.catch(() => undefined);

  try {
    return await Promise.race([call, ...races]);
  } finally {
    if (timer) clearTimeout(timer);
    detach?.();
  }
}
