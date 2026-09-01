/**
 * The turn ran out of time before the model was ever reached.
 *
 * Its own class rather than `LlmDeadlineExceededError`, which would otherwise
 * be the obvious reuse: `LlmError`'s constructor requires an
 * `LlmCallTelemetry`, and the pre-model phase has none — no provider, no
 * model, no attempts. `LlmService.budgetFor` is already forced to fabricate a
 * zeroed one, and that smell is not worth propagating to a layer that has the
 * choice not to.
 *
 * It exists so the agent can make the same distinction `LlmService` already
 * makes in `deadlineCaused`: **out of time is not the same as broken.** A turn
 * that expires during retrieval is a capacity fact, and logging it at ERROR
 * next to genuine failures is what made the 2026-09-01 incident read as five
 * separate faults instead of one slow embedder.
 */
export class AgentDeadlineExceededError extends Error {
  constructor(
    /** Which phase was about to start — `categories`, `history`, `retrieval`, `chain`. */
    readonly phase: string,
    readonly remainingMs: number,
    readonly floorMs: number,
  ) {
    super(
      `vova turn ran out of time before ${phase} ` +
        `(${remainingMs}ms left, ${floorMs}ms floor)`,
    );
    this.name = 'AgentDeadlineExceededError';
  }
}
