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
  PROVIDERS_REQUIRING_FLAT_CONTENT,
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
  LlmFatalError,
  LlmNoProviderError,
} from './llm.errors';
import {
  specId,
  type LlmCallTelemetry,
  type LlmInvokeResult,
  type LlmProviderSpec,
  type LlmTier,
} from './llm.types';

export interface LlmInvokeOptions {
  tier: LlmTier;
  /** Bound with `bindTools` when present. A provider without tool support fails fatal. */
  tools?: BindToolsInput[];
  /** Per-attempt budget, not per-chain. Defaults to `VOVA_LLM_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** `requestIdMiddleware`'s id, so one conversation is greppable end to end. */
  correlationId?: string;
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
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly defaultTimeoutMs: number;
  /** Pause before the single retry a 5xx earns. */
  private readonly retryBackoffMs: number;

  constructor(
    private readonly factory: LlmModelFactory,
    private readonly breaker: LlmBreakerService,
    config: ConfigService,
  ) {
    this.defaultTimeoutMs = readNumber(config, 'VOVA_LLM_TIMEOUT_MS', 20000);
    this.retryBackoffMs = readNumber(config, 'VOVA_LLM_RETRY_BACKOFF_MS', 250);
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
    const chain = resolveChain(tier);
    const open = await Promise.all(chain.map((s) => this.breaker.isOpen(s)));
    return chain.filter((_, i) => !open[i]);
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
    };

    try {
      const output = await this.callWithRetry(spec, input, options, telemetry);
      await this.breaker.recordSuccess(spec);
      telemetry.latencyMs = Date.now() - startedAt;
      this.readUsage(output, telemetry);
      this.log(telemetry, options.correlationId, 'ok');
      return { output, telemetry };
    } catch (err) {
      const cls = classifyLlmError(err);
      if (shouldTripBreaker(cls)) await this.breaker.recordFailure(spec);
      telemetry.latencyMs = Date.now() - startedAt;
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
    };

    if (chain.length === 0) {
      telemetry.latencyMs = Date.now() - startedAt;
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
      runnable = model as unknown as Runnable<
        BaseLanguageModelInput,
        AIMessage
      >;
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return withTimeout(
      (signal) =>
        runnable.invoke(
          PROVIDERS_REQUIRING_FLAT_CONTENT.has(spec.provider)
            ? flattenContent(input)
            : input,
          { signal },
        ),
      timeoutMs,
      specId(spec),
    );
  }

  private readUsage(output: AIMessage, telemetry: LlmCallTelemetry): void {
    const usage = output.usage_metadata;
    telemetry.inputTokens = usage?.input_tokens ?? null;
    telemetry.outputTokens = usage?.output_tokens ?? null;
  }

  /**
   * One line per call, in the shape an incident is actually read in. A rising
   * `depth` is the earliest signal a provider is degrading, and it is invisible
   * in latency alone.
   */
  private log(
    t: LlmCallTelemetry,
    correlationId: string | undefined,
    outcome: 'ok' | 'fatal' | 'exhausted',
  ): void {
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
    if (correlationId) parts.push(`request_id=${correlationId}`);

    const line = `vova.llm ${parts.join(' ')}`;
    if (outcome === 'ok') this.logger.log(line);
    else this.logger.error(line);
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
 */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err = new Error(`${label} timed out after ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, timeoutMs);
  });

  const call = run(controller.signal);
  call.catch(() => undefined);

  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
