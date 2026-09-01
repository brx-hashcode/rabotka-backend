import { Deadline } from '../deadline';

/**
 * Real timers with small values rather than `jest.useFakeTimers()`, matching
 * the house style in `llm.service.spec.ts` — the assertions here are about
 * promise/abort interleaving, which fake timers make harder to reason about
 * than the few milliseconds they save.
 */
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Deadline', () => {
  it('reports the time it has left, floored at zero', async () => {
    const d = Deadline.start(60, 'test');

    expect(d.remainingMs()).toBeGreaterThan(40);
    expect(d.remainingMs()).toBeLessThanOrEqual(60);
    expect(d.expired()).toBe(false);

    await tick(80);

    // Floored, not negative: `budgetFor` does arithmetic on this value and a
    // negative would silently widen a budget instead of closing it.
    expect(d.remainingMs()).toBe(0);
    expect(d.expired()).toBe(true);
    d.dispose();
  });

  it('aborts its signal when the budget expires', async () => {
    const d = Deadline.start(40, 'test');
    expect(d.signal.aborted).toBe(false);
    expect(d.causedAbort()).toBe(false);

    await tick(70);

    expect(d.signal.aborted).toBe(true);
    expect(d.causedAbort()).toBe(true);
    d.dispose();
  });

  it('aborts on dispose so nothing outlives the answer', () => {
    // The orphaned-work fix: when a turn finishes early, a losing raced run or
    // an unread graph step should stop now rather than in 20s.
    const d = Deadline.start(10_000, 'test');
    d.dispose();

    expect(d.signal.aborted).toBe(true);
  });

  it('is safe to dispose twice', () => {
    const d = Deadline.start(10_000, 'test');
    d.dispose();
    expect(() => d.dispose()).not.toThrow();
  });

  it('does not fire after dispose', async () => {
    const d = Deadline.start(30, 'test');
    const seen: string[] = [];
    d.signal.addEventListener('abort', () => seen.push('abort'));

    d.dispose();
    await tick(60);

    // One abort, from dispose — not a second one when the timer would have run.
    expect(seen).toEqual(['abort']);
  });

  it('treats a non-positive budget as already spent', () => {
    const d = Deadline.start(0, 'test');
    expect(d.remainingMs()).toBe(0);
    expect(d.expired()).toBe(true);
    d.dispose();
  });
});
