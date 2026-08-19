import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  BaseChatModelParams,
  BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { LlmService } from '../llm/llm.service';
import type {
  LlmCallTelemetry,
  LlmProviderSpec,
  LlmTier,
} from '../llm/llm.types';

export interface FallbackChatModelFields extends BaseChatModelParams {
  llm: LlmService;
  tier: LlmTier;
  /** The one provider this run is pinned to. */
  spec: LlmProviderSpec;
  correlationId?: string;
  tools?: BindToolsInput[];
  onTelemetry?: (telemetry: LlmCallTelemetry) => void;
}

export class FallbackChatModel extends BaseChatModel {
  private readonly llm: LlmService;
  private readonly tier: LlmTier;
  private readonly spec: LlmProviderSpec;
  private readonly correlationId?: string;
  private readonly tools?: BindToolsInput[];
  private readonly onTelemetry?: (telemetry: LlmCallTelemetry) => void;

  constructor(fields: FallbackChatModelFields) {
    super(fields);
    this.llm = fields.llm;
    this.tier = fields.tier;
    this.spec = fields.spec;
    this.correlationId = fields.correlationId;
    this.tools = fields.tools;
    this.onTelemetry = fields.onTelemetry;
  }

  _llmType(): string {
    return 'vova-fallback';
  }

  override bindTools(tools: BindToolsInput[]): FallbackChatModel {
    return new FallbackChatModel({
      llm: this.llm,
      tier: this.tier,
      spec: this.spec,
      correlationId: this.correlationId,
      onTelemetry: this.onTelemetry,
      tools,
    });
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const { output, telemetry } = await this.llm.invokeWith(
      this.spec,
      messages,
      {
        tier: this.tier,
        tools: this.tools,
        correlationId: this.correlationId,
      },
    );

    this.onTelemetry?.(telemetry);

    return {
      generations: [
        {
          text:
            typeof output.content === 'string'
              ? output.content
              : JSON.stringify(output.content),
          message: output,
        },
      ],
      llmOutput: {
        model: telemetry.model,
        provider: telemetry.provider,
        fallbackDepth: telemetry.fallbackDepth,
      },
    };
  }
}
