/**
 * Shared vocabulary for the model layer.
 *
 * Nothing here imports a provider SDK — only `model-factory.service.ts` does.
 * Every other file in the module talks about a provider through
 * {@link LlmProviderSpec}, so adding a provider is one entry in
 * `models.config.ts` plus one branch in the factory.
 */

/**
 * Which chain a call is routed to.
 *
 * `cheap` exists for the pre-filter and for greetings — work where a smaller
 * model is indistinguishable and the volume is high. `standard` is everything
 * that can reach a tool or a corpus chunk.
 */
export type LlmTier = 'cheap' | 'standard';

export type LlmProviderName = 'google' | 'mistral' | 'openai';

export interface LlmProviderSpec {
  provider: LlmProviderName;
  model: string;
}

/** `provider:model` — the id used in logs, breaker keys and telemetry. */
export function specId(spec: LlmProviderSpec): string {
  return `${spec.provider}:${spec.model}`;
}

/**
 * What one completed call cost us, in the terms an on-call engineer asks about.
 *
 * `fallbackDepth` is the point: 0 means the tier's first choice answered, 2
 * means two providers were unusable before one did. A rising average is the
 * earliest signal that a provider is degrading, and it is invisible in latency
 * alone.
 */
export interface LlmCallTelemetry {
  tier: LlmTier;
  provider: LlmProviderName | null;
  model: string | null;
  fallbackDepth: number;
  latencyMs: number;
  /** Total provider calls made, including the single retry a 5xx earns. */
  attempts: number;
  /** Skipped without being called because their breaker was open. */
  breakerSkipped: string[];
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface LlmInvokeResult<T> {
  output: T;
  telemetry: LlmCallTelemetry;
}
