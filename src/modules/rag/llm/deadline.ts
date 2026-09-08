/**
 * One turn's wall-clock budget, shared by everything the turn does.
 *
 * The problem this exists for: the per-attempt cap and the turn budget used to
 * be two unrelated numbers, and they did not fit inside each other. A 20000ms
 * per-attempt cap inside a 25000ms turn meant one stalled call consumed 80% of
 * the turn, so the fallback chain was unreachable BY ARITHMETIC — a second
 * provider could only ever help the *next* message. Production, 2026-09-01:
 *
 *   step 1 · google/gemini-3.6-flash · 5116ms · a 28-token tool call
 *   step 2 · stalled, then latency_ms=20007 — the per-attempt cap
 *   …the turn budget had already fired 4s earlier and answered the user.
 *   Then the chain restarted on anthropic, cold-imported its SDK, failed,
 *   and started mistral — all of it after the user had been answered.
 *
 * A deadline fixes both halves. Per-call budgets are derived from what is
 * ACTUALLY LEFT rather than from a fixed constant, so a fallback always has
 * room; and the signal gives every layer below a way to stop, so work does not
 * outlive the answer it was computing.
 *
 * Deliberately dependency-free — no Nest, no config, no clock injection — so it
 * unit-tests under `jest.useFakeTimers()` and can be constructed anywhere.
 */
export class Deadline {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Phases that finished, name → elapsed ms. */
  private readonly marks = new Map<string, number>();
  /** Phases still running, name → when they started. */
  private readonly open = new Map<string, number>();

  private constructor(
    readonly label: string,
    readonly endsAt: number,
  ) {}

  /**
   * Time one phase of the turn. Returns the closer; call it in a `finally`.
   *
   * The marks live HERE rather than in the caller for one reason: this object
   * is the only thing that crosses the `VovaService` ↔ `VovaAgentService`
   * boundary and survives the outer race being LOST. When a turn expires,
   * `VovaService` answers the user and moves on while the agent is still
   * running — so a log line written by the agent lands out of order, or never.
   * The reader sits on the winning side and can always print what it has.
   *
   * That property is the whole point. The 2026-09-01 incident had no
   * `vova.llm` line at all, and nothing timing the phase that actually ate the
   * budget, so the log could not say where 25 seconds went.
   */
  beginPhase(name: string): () => void {
    const startedAt = Date.now();
    this.open.set(name, startedAt);

    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.open.delete(name);
      this.marks.set(name, Date.now() - startedAt);
    };
  }

  /**
   * The phases, as one log fragment.
   *
   * `pending=` is not decoration: the incident's signature is "retrieval
   * started and never finished", which a map of completed phases cannot
   * express. Unfinished phases are reported with their elapsed time AT READ
   * TIME, which is what makes the phase that is still burning visible from the
   * side that gave up waiting for it.
   */
  marksLine(): string {
    const parts = [...this.marks].map(([name, ms]) => `${name}_ms=${ms}`);

    const now = Date.now();
    const pending = [...this.open].map(
      ([name, startedAt]) => `${name}@${now - startedAt}`,
    );
    parts.push(`pending=${pending.length ? pending.join(',') : '—'}`);

    return parts.join(' ');
  }

  /**
   * Start a budget of `totalMs` from now.
   *
   * The timer is `unref`'d where the runtime supports it: a pending deadline
   * must never be the reason the process stays alive at shutdown.
   */
  static start(totalMs: number, label: string): Deadline {
    const deadline = new Deadline(label, Date.now() + Math.max(0, totalMs));

    deadline.timer = setTimeout(
      () => {
        deadline.timer = null;
        deadline.abort(`${label} exceeded its ${totalMs}ms budget`);
      },
      Math.max(0, totalMs),
    );

    deadline.timer.unref?.();
    return deadline;
  }

  /** Aborts when the budget expires, or when {@link dispose} is called. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Milliseconds left, floored at zero. Never negative — callers do arithmetic on it. */
  remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  expired(): boolean {
    return this.remainingMs() === 0;
  }

  /**
   * True when this deadline is why something aborted.
   *
   * The distinction matters more than it looks: `classifyLlmError` maps an
   * `AbortError` to `transport`, and `shouldTripBreaker('transport')` is true —
   * so without asking this question, a turn running out of time would record a
   * failure against every provider still in flight, through no fault of theirs.
   * Under load that opens breakers on healthy vendors, which is the classic
   * cascading-failure shape.
   */
  causedAbort(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Release the timer. **Must** run in a `finally`.
   *
   * Without it every message leaves a live 25s timer behind on the hottest path
   * in the bot. Aborting on dispose is deliberate rather than incidental: when
   * a turn finishes early, anything still running on its behalf — a hedge's
   * losing run, a graph step nobody will read — should stop now, not in 20s.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.abort(`${this.label} finished`);
  }

  private abort(reason: string): void {
    if (this.controller.signal.aborted) return;
    const err = new Error(reason);
    err.name = 'TimeoutError';
    this.controller.abort(err);
  }
}
