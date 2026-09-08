import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  BaseChatModelParams,
  BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { LlmService } from '../llm/llm.service';
import type { Deadline } from '../llm/deadline';
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
  /**
   * The turn's budget. **Required, and required for a reason** — see
   * `bindTools` below. `null` is the explicit way to say "no budget", so that
   * omitting it is a compile error rather than a silent no-op.
   */
  deadline: Deadline | null;
  /** `0` on the last provider in the chain. See `LlmInvokeOptions.reserveMs`. */
  reserveMs?: number;
}

export class FallbackChatModel extends BaseChatModel {
  private readonly llm: LlmService;
  private readonly tier: LlmTier;
  private readonly spec: LlmProviderSpec;
  private readonly correlationId?: string;
  private readonly tools?: BindToolsInput[];
  private readonly onTelemetry?: (telemetry: LlmCallTelemetry) => void;
  private readonly deadline: Deadline | null;
  private readonly reserveMs?: number;

  constructor(fields: FallbackChatModelFields) {
    super(fields);
    this.llm = fields.llm;
    this.tier = fields.tier;
    this.spec = fields.spec;
    this.correlationId = fields.correlationId;
    this.tools = fields.tools;
    this.onTelemetry = fields.onTelemetry;
    this.deadline = fields.deadline;
    this.reserveMs = fields.reserveMs;
  }

  _llmType(): string {
    return 'vova-fallback';
  }

  /**
   * LangGraph calls this, so **the instance that actually runs the turn is the
   * one returned here** — not the one the agent constructed.
   *
   * Every field therefore has to be re-listed, and a field forgotten here is
   * silently dropped for the entire run. `deadline` is typed as required (with
   * `null` as the explicit opt-out) precisely so that omitting it fails the
   * build instead of quietly disabling every budget clamp in the service below.
   */
  override bindTools(tools: BindToolsInput[]): FallbackChatModel {
    return new FallbackChatModel({
      llm: this.llm,
      tier: this.tier,
      spec: this.spec,
      correlationId: this.correlationId,
      onTelemetry: this.onTelemetry,
      deadline: this.deadline,
      reserveMs: this.reserveMs,
      tools,
    });
  }

  async _generate(
    messages: BaseMessage[],
    options?: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const { output, telemetry } = await this.llm.invokeWith(
      this.spec,
      messages,
      {
        tier: this.tier,
        tools: this.tools,
        correlationId: this.correlationId,
        deadline: this.deadline ?? undefined,
        reserveMs: this.reserveMs,
        // Previously dropped on the floor: `_generate` did not declare this
        // parameter at all, so LangGraph's per-run signal never reached the
        // SDK and an aborted graph kept billing calls to the end.
        signal: options?.signal,
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
