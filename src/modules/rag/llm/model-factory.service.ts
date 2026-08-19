import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { PROVIDER_API_KEY_ENV } from './models.config';
import { specId, type LlmProviderSpec } from './llm.types';
import { readNumber } from '../shared/config';

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
@Injectable()
export class LlmModelFactory {
  private readonly logger = new Logger(LlmModelFactory.name);
  private readonly cache = new Map<string, BaseChatModel>();

  constructor(private readonly config: ConfigService) {}

  async build(spec: LlmProviderSpec): Promise<BaseChatModel> {
    const cached = this.cache.get(specId(spec));
    if (cached) return cached;

    const apiKey = this.config.get<string>(PROVIDER_API_KEY_ENV[spec.provider]);
    if (!apiKey || apiKey.trim().length === 0) {
      // resolveChain() filters these out before we get here; reaching this is a
      // wiring bug, and it is worth saying so rather than failing later with an
      // opaque 401 from the vendor.
      throw new Error(
        `No ${PROVIDER_API_KEY_ENV[spec.provider]} configured for ${specId(spec)}`,
      );
    }

    const model = await this.construct(spec, apiKey.trim());
    this.cache.set(specId(spec), model);
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
      temperature: readNumber(this.config, 'VOVA_TEMPERATURE', 0.2),
      maxRetries: 0,
    };

    // The casts are the price of the dynamic import: it resolves each package's
    // ESM type definitions, while the rest of the app sees the CJS ones, so the
    // two `BaseChatModel` symbols are structurally identical and nominally
    // distinct. Contained to this file, which is the only place that touches a
    // provider SDK at all.
    switch (spec.provider) {
      case 'google': {
        const { ChatGoogleGenerativeAI } =
          await import('@langchain/google-genai');
        return new ChatGoogleGenerativeAI({
          ...shared,
          model: spec.model,
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
          model: spec.model,
        }) as unknown as BaseChatModel;
      }
    }
  }
}
