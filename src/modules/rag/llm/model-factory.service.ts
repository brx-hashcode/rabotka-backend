import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
// `import type` only — erased at compile time, so this costs none of the heap
// the runtime `import()`s below are carefully avoiding.
import type { GoogleGenerativeAIChatInput } from '@langchain/google-genai';
import { PROVIDER_API_KEY_ENV } from './models.config';
import { specId, type LlmProviderSpec } from './llm.types';
import { readNumber } from '../shared/config';

/**
 * Derived from the SDK's public input type rather than imported directly:
 * `GoogleGenerativeAIThinkingLevel` lives in the package's internal
 * `types.d.ts` and is re-exported from neither the root nor a subpath, so
 * naming it would mean a deep import into `dist/`. Reaching it through
 * `thinkingConfig` keeps us on the supported surface and still fails the build
 * if the vendor changes the shape.
 */
type GoogleThinkingConfig = NonNullable<
  GoogleGenerativeAIChatInput['thinkingConfig']
>;
type GoogleThinkingLevel = NonNullable<GoogleThinkingConfig['thinkingLevel']>;

/** Accepted values of `VOVA_GOOGLE_THINKING_LEVEL`, plus our own `off`. */
const THINKING_LEVELS = new Set<GoogleThinkingLevel>([
  'THINKING_LEVEL_UNSPECIFIED',
  'LOW',
  'MEDIUM',
  'HIGH',
]);

/**
 * The only file in the application allowed to import a provider SDK.
 *
 * Everything else names a provider through {@link LlmProviderSpec}, so adding
 * a fourth vendor is one entry in `models.config.ts` and one branch here.
 *
 * Models are built once and cached: constructing a chat model allocates an HTTP
 * client, and rebuilding it per message would discard connection reuse on the
 * hottest path in the assistant.
 */
/**
 * What GPT-5.6 and GPT-6 ask for, measured on the API (2026-11-25): a
 * temperature is refused (400) unless reasoning is off, which Luna and Terra
 * allow and the larger ones (Sol, Astra) do not. `@langchain/openai` does not
 * know these names as reasoning models, so it would not send the effort itself.
 */
export function openAiParams(
  model: string,
  temperature: number,
): { temperature?: number; modelKwargs?: Record<string, unknown> } {
  if (!/^gpt-(5\.6|6(\.\d+)?)-/.test(model)) return { temperature };
  return /-(luna|terra)(-|$)/.test(model)
    ? { temperature, modelKwargs: { reasoning_effort: 'none' } }
    : { temperature: undefined };
}

/**
 * Since Haiku 5.5, and Opus 4.7 before it, Claude refuses a temperature
 * (`400`) and thinks before answering unless told not to. Haiku answers a
 * WhatsApp turn, so it does not think. `maxTokens`: the installed LangChain
 * does not know the model and would cut its answers at 4096.
 */
export function anthropicParams(
  model: string,
  temperature: number,
): {
  temperature?: number;
  thinking?: { type: 'disabled' };
  maxTokens?: number;
} {
  if (/^claude-haiku-5/.test(model)) {
    return {
      temperature: undefined,
      thinking: { type: 'disabled' },
      maxTokens: 16_384,
    };
  }
  return /^claude-(opus-(4-[78]|5)|sonnet-5|fable|mythos)/.test(model)
    ? { temperature: undefined, maxTokens: 16_384 }
    : { temperature };
}

@Injectable()
export class LlmModelFactory {
  private readonly logger = new Logger(LlmModelFactory.name);
  private readonly cache = new Map<string, BaseChatModel>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Can this spec actually be built?
   *
   * Reads the SAME source `build` does, which `models.config.ts`'s
   * `hasCredential` does not: that one inspects `process.env` directly, while
   * everything here goes through `ConfigService` — which is populated from
   * `.env.local`/`.env`, cached at boot, and runs `expandVariables`. The two
   * can therefore disagree, and the direction that hurts is a provider passing
   * the static gate and then failing here: `build` throws a plain Error, which
   * classifies as `transport` and trips the provider's breaker for a
   * misconfiguration of ours.
   *
   * That was survivable while the chain was walked one provider at a time. Once
   * runs are raced it is not — a miswired provider would consume a race slot on
   * every turn and take a healthy vendor's breaker down with it.
   */
  hasCredential(spec: LlmProviderSpec): boolean {
    const key = this.config.get<string>(PROVIDER_API_KEY_ENV[spec.provider]);
    return typeof key === 'string' && key.trim().length > 0;
  }

  /** One model per spec, and per temperature when one is asked. */
  async build(
    spec: LlmProviderSpec,
    temperature?: number,
  ): Promise<BaseChatModel> {
    const id =
      temperature === undefined
        ? specId(spec)
        : `${specId(spec)}@${temperature}`;
    const cached = this.cache.get(id);
    if (cached) return cached;

    if (!this.hasCredential(spec)) {
      // `usableChain()` filters these out before we get here; reaching this is a
      // wiring bug, and it is worth saying so rather than failing later with an
      // opaque 401 from the vendor.
      throw new Error(
        `No ${PROVIDER_API_KEY_ENV[spec.provider]} configured for ${specId(spec)}`,
      );
    }

    const apiKey = this.config.get<string>(
      PROVIDER_API_KEY_ENV[spec.provider],
    ) as string;

    const model = await this.construct(spec, apiKey.trim(), temperature);
    this.cache.set(id, model);
    this.logger.debug(`Built chat model ${specId(spec)}`);
    return model;
  }

  /**
   * Imported at CALL time, not at module load.
   *
   * Statically imported, the three SDKs cost ~83 MB of heap at boot — Mistral
   * alone is 67 — and pushed the app from ~131 MB to 214 against a 150 MB
   * terminus limit, so `/health` answered 503 and the deploy smoke test failed.
   *
   * The assistant ships disabled, so that was paid on every boot for a feature
   * nobody was using. Now it is paid the first time a model is actually built,
   * and never on an instance where VoVa is off.
   */
  private async construct(
    spec: LlmProviderSpec,
    apiKey: string,
    temperature?: number,
  ): Promise<BaseChatModel> {
    /**
     * Shared across vendors.
     *
     * `maxRetries: 0` is the load-bearing one. Every SDK here retries on its
     * own by default (the OpenAI client twice), which would silently triple the
     * time before our chain even learns the call failed, hide the failure from
     * the breaker, and make `fallbackDepth` a lie. Retry policy belongs to
     * `LlmService` — see `isRetryableInPlace`.
     */
    const shared = {
      apiKey,
      temperature:
        temperature ?? readNumber(this.config, 'VOVA_TEMPERATURE', 0.2),
      maxRetries: 0,
    };

    // The casts are the price of the dynamic import: it resolves each package's
    // ESM type definitions, while the rest of the app sees the CJS ones, so the
    // two `BaseChatModel` symbols are structurally identical and nominally
    // distinct. Contained to this file, which is the only place that touches a
    // provider SDK at all.
    switch (spec.provider) {
      case 'anthropic': {
        const { ChatAnthropic } = await import('@langchain/anthropic');
        return new ChatAnthropic({
          ...shared,
          ...anthropicParams(spec.model, shared.temperature),
          model: spec.model,
        }) as unknown as BaseChatModel;
      }
      case 'google': {
        const { ChatGoogleGenerativeAI } =
          await import('@langchain/google-genai');
        return new ChatGoogleGenerativeAI({
          ...shared,
          model: spec.model,
          ...this.thinkingFor(spec),
        }) as unknown as BaseChatModel;
      }
      case 'mistral': {
        const { ChatMistralAI } = await import('@langchain/mistralai');
        return new ChatMistralAI({
          ...shared,
          model: spec.model,
        }) as unknown as BaseChatModel;
      }
      case 'openai': {
        const { ChatOpenAI } = await import('@langchain/openai');
        return new ChatOpenAI({
          ...shared,
          ...openAiParams(spec.model, shared.temperature),
          model: spec.model,
        }) as unknown as BaseChatModel;
      }
      case 'groq': {
        const { ChatGroq } = await import('@langchain/groq');
        return new ChatGroq({
          ...shared,
          model: spec.model,
        }) as unknown as BaseChatModel;
      }
      case 'deepseek': {
        // Built on the OpenAI client (DeepSeek's API is OpenAI-compatible), so
        // this branch costs almost nothing beyond `@langchain/openai`, which is
        // already loaded whenever that provider is reached.
        const { ChatDeepSeek } = await import('@langchain/deepseek');
        return new ChatDeepSeek({
          ...shared,
          model: spec.model,
        }) as unknown as BaseChatModel;
      }
    }
  }

  /**
   * Cap what a Gemini model is allowed to think before it answers.
   *
   * Unconstrained, `gemini-3.6-flash` spent 5116ms on a turn whose entire output
   * was a 28-token tool call, then stalled a second step past the 20s per-call
   * cap — which expired the whole turn budget before the chain could reach a
   * second provider. Thinking is priced in wall-clock on a WhatsApp budget, and
   * this assistant's turns are lookups, not proofs.
   *
   * Two shapes, not one, because the vendor changed the contract mid-generation:
   * 2.x accepts `thinkingBudget: 0` to disable thinking outright, while 3.x
   * rejects it and requires a level of at least LOW. Encoding both keeps `off`
   * available where it works and failing loudly where it does not — preferable
   * to a single default that is silently wrong for half the chain.
   */
  private thinkingFor(spec: LlmProviderSpec): {
    thinkingConfig: GoogleThinkingConfig;
  } {
    const raw = (
      this.config.get<string>('VOVA_GOOGLE_THINKING_LEVEL') ?? 'LOW'
    ).trim();

    if (raw === 'off') return { thinkingConfig: { thinkingBudget: 0 } };

    if (!THINKING_LEVELS.has(raw as GoogleThinkingLevel)) {
      // Not fatal: a typo in an env var should not take the assistant down, and
      // LOW is the value we would have chosen anyway. It IS worth a warning,
      // because the symptom otherwise is "latency never improved".
      this.logger.warn(
        `VOVA_GOOGLE_THINKING_LEVEL="${raw}" is not a valid level for ` +
          `${specId(spec)} — falling back to LOW. Valid: ` +
          `${[...THINKING_LEVELS].join(', ')}, off.`,
      );
      return { thinkingConfig: { thinkingLevel: 'LOW' } };
    }

    return { thinkingConfig: { thinkingLevel: raw as GoogleThinkingLevel } };
  }
}
