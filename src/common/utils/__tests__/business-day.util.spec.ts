import {
  startOfBusinessDay,
  startOfNextBusinessDay,
} from '../business-day.util';

describe('business-day util', () => {
  it('truncates to the most recent UTC+1 midnight', () => {
    // 10:00 UTC on 30 Jul = 11:00 local, so the day began at 23:00 UTC on 29 Jul.
    expect(
      startOfBusinessDay(new Date('2026-07-30T10:00:00Z')).toISOString(),
    ).toBe('2026-07-29T23:00:00.000Z');
  });

  it('rolls over at 23:00 UTC, not at 00:00 UTC', () => {
    // 22:59 UTC is still the previous local day...
    expect(
      startOfBusinessDay(new Date('2026-07-30T22:59:59Z')).toISOString(),
    ).toBe('2026-07-29T23:00:00.000Z');
    // ...and 23:00 UTC starts the new one.
    expect(
      startOfBusinessDay(new Date('2026-07-30T23:00:00Z')).toISOString(),
    ).toBe('2026-07-30T23:00:00.000Z');
  });

  it('is exactly on the boundary at local midnight', () => {
    const localMidnight = new Date('2026-07-30T23:00:00Z');
    expect(startOfBusinessDay(localMidnight).getTime()).toBe(
      localMidnight.getTime(),
    );
  });

  it('gives the same answer in January and July (Congo has no DST)', () => {
    expect(
      startOfBusinessDay(new Date('2026-01-15T10:00:00Z')).toISOString(),
    ).toBe('2026-01-14T23:00:00.000Z');
    expect(
      startOfBusinessDay(new Date('2026-07-15T10:00:00Z')).toISOString(),
    ).toBe('2026-07-14T23:00:00.000Z');
  });

  it('does not depend on the process timezone', () => {
    const original = process.env.TZ;
    const at = new Date('2026-07-30T10:00:00Z');
    try {
      process.env.TZ = 'America/New_York';
      const a = startOfBusinessDay(at).toISOString();
      process.env.TZ = 'Asia/Shanghai';
      const b = startOfBusinessDay(at).toISOString();
      expect(a).toBe(b);
      expect(a).toBe('2026-07-29T23:00:00.000Z');
    } finally {
      process.env.TZ = original;
    }
  });

  it('resets exactly 24h after the day started', () => {
    const at = new Date('2026-07-30T10:00:00Z');
    expect(startOfNextBusinessDay(at).getTime()).toBe(
      startOfBusinessDay(at).getTime() + 24 * 60 * 60 * 1000,
    );
    expect(startOfNextBusinessDay(at).toISOString()).toBe(
      '2026-07-30T23:00:00.000Z',
    );
  });
});
