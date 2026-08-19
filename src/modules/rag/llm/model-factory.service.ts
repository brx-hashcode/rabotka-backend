import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatMistralAI } from '@langchain/mistralai';
import { ChatOpenAI } from '@langchain/openai';
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

  build(spec: LlmProviderSpec): BaseChatModel {
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

    const model = this.construct(spec, apiKey.trim());
    this.cache.set(specId(spec), model);
    this.logger.debug(`Built chat model ${specId(spec)}`);
    return model;
  }

  private construct(spec: LlmProviderSpec, apiKey: string): BaseChatModel {
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

    switch (spec.provider) {
      case 'google':
        return new ChatGoogleGenerativeAI({ ...shared, model: spec.model });
      case 'mistral':
        return new ChatMistralAI({ ...shared, model: spec.model });
      case 'openai':
        return new ChatOpenAI({ ...shared, model: spec.model });
    }
  }
}
