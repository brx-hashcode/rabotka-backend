import { nudgeJobId } from '../profile-chat.nudge';

const CONV = 'c-1';
const RECIPIENT = 'p-1';
const DELAY = 300;

/**
 * The job id is the whole grouping mechanism, and it is also where this repo
 * has already been bitten once: a broadcast sat stuck in SENDING because BullMQ
 * keeps completed jobs for an hour and silently swallows a repeat id.
 *
 * So both halves are asserted — that a burst collapses, and that the next
 * window does NOT.
 */
describe('nudgeJobId', () => {
  const at = (seconds: number) => new Date('2026-09-22T10:00:00Z').getTime() + seconds * 1000;

  it('collapses a burst inside one window into one job', () => {
    const first = nudgeJobId(CONV, RECIPIENT, DELAY, at(0));
    const later = nudgeJobId(CONV, RECIPIENT, DELAY, at(120));
    expect(later).toBe(first);
  });

  it('mints a NEW id for the next window', () => {
    // Without this, the second nudge of the hour is dropped with no trace —
    // exactly the broadcast bug, in a place nobody would look.
    const first = nudgeJobId(CONV, RECIPIENT, DELAY, at(0));
    const next = nudgeJobId(CONV, RECIPIENT, DELAY, at(DELAY * 2));
    expect(next).not.toBe(first);
  });

  it('rotates well inside BullMQ’s one-hour retention of completed jobs', () => {
    const ids = new Set(
      Array.from({ length: 12 }, (_, i) =>
        nudgeJobId(CONV, RECIPIENT, DELAY, at(i * DELAY)),
      ),
    );
    // Twelve distinct ids an hour at the default delay: a completed job is
    // never still in the keyspace when its id comes round again.
    expect(ids.size).toBe(12);
  });

  it('keeps the two recipients of one conversation apart', () => {
    expect(nudgeJobId(CONV, 'w-1', DELAY, at(0))).not.toBe(
      nudgeJobId(CONV, 'e-1', DELAY, at(0)),
    );
  });

  it('keeps two conversations of one recipient apart', () => {
    expect(nudgeJobId('c-1', RECIPIENT, DELAY, at(0))).not.toBe(
      nudgeJobId('c-2', RECIPIENT, DELAY, at(0)),
    );
  });

  it('does not divide by zero on a nonsense delay', () => {
    expect(() => nudgeJobId(CONV, RECIPIENT, 0, at(0))).not.toThrow();
    expect(nudgeJobId(CONV, RECIPIENT, 0, at(0))).toMatch(/^nudge-/);
  });
});
