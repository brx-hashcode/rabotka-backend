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
