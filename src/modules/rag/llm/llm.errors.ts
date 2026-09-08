import type { LlmCallTelemetry } from './llm.types';

export abstract class LlmError extends Error {
  constructor(
    message: string,
    readonly telemetry: LlmCallTelemetry,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class LlmFatalError extends LlmError {}

export class LlmChainExhaustedError extends LlmError {}

export class LlmNoProviderError extends LlmError {}

/**
 * The turn ran out of budget before this call could usefully start.
 *
 * Distinct from {@link LlmChainExhaustedError} because it says nothing about
 * the provider: nobody failed, there was simply no time left. Issuing the call
 * anyway would bill a full prompt for a response guaranteed to arrive after the
 * user had already been answered — which is precisely the orphaned spend the
 * deadline exists to stop.
 */
export class LlmDeadlineExceededError extends LlmError {}
