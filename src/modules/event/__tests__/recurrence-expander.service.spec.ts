import { RecurrenceFrequency } from '@prisma/client';
import {
  MAX_OCCURRENCES_PER_SERIES,
  RecurrenceExpanderService,
} from '../services/recurrence-expander.service';

const FAR_FUTURE = new Date('2100-01-01T00:00:00.000Z');

describe('RecurrenceExpanderService', () => {
  const service = new RecurrenceExpanderService();

  /** 09:00–10:30 UTC, so a lost hour or a lost 30 minutes is visible. */
  const anchorStart = new Date('2026-08-17T09:00:00.000Z');
  const anchorEnd = new Date('2026-08-17T10:30:00.000Z');

  const expand = (overrides: Partial<Parameters<typeof service.expand>[0]>) =>
    service.expand({
      anchorStart,
      anchorEnd,
      frequency: RecurrenceFrequency.WEEKLY,
      horizonEnd: FAR_FUTURE,
      maxRows: 1000,
      ...overrides,
    });

  describe('expand()', () => {
    it('emits `count` occurrences, indexed from zero', () => {
      const result = expand({
        frequency: RecurrenceFrequency.DAILY,
        count: 5,
      });

      expect(result).toHaveLength(5);
      expect(result.map((o) => o.index)).toEqual([0, 1, 2, 3, 4]);
      expect(result[0].start.toISOString()).toBe('2026-08-17T09:00:00.000Z');
      expect(result[4].start.toISOString()).toBe('2026-08-21T09:00:00.000Z');
    });

    it('stops at `until`, inclusive', () => {
      const until = new Date('2026-09-07T23:59:59.000Z');
      const result = expand({ until });

      // Aug 17, 24, 31, Sep 7 — the 14th falls outside.
      expect(result).toHaveLength(4);
      expect(result.at(-1)?.start.toISOString()).toBe(
        '2026-09-07T09:00:00.000Z',
      );
      for (const o of result) {
        expect(o.start.getTime()).toBeLessThanOrEqual(until.getTime());
      }
    });

    it('preserves the duration of every occurrence', () => {
      const result = expand({
        frequency: RecurrenceFrequency.MONTHLY,
        count: 6,
      });

      for (const o of result) {
        expect(o.end.getTime() - o.start.getTime()).toBe(90 * 60 * 1000);
      }
    });

    it('preserves the time of day across the whole series', () => {
      // The reason the arithmetic is on UTC components rather than adding
      // 86_400_000 ms: a fixed millisecond step drifts by an hour whenever a
      // series crosses a daylight-saving boundary.
      const result = expand({
        anchorStart: new Date('2026-10-25T09:00:00.000Z'),
        anchorEnd: new Date('2026-10-25T10:00:00.000Z'),
        frequency: RecurrenceFrequency.DAILY,
        count: 10,
      });

      for (const o of result) {
        expect(o.start.getUTCHours()).toBe(9);
        expect(o.start.getUTCMinutes()).toBe(0);
      }
    });

    it('stops at the horizon when the series is open-ended', () => {
      const result = expand({
        frequency: RecurrenceFrequency.DAILY,
        horizonEnd: new Date('2026-08-20T23:59:59.000Z'),
      });

      expect(result).toHaveLength(4); // 17, 18, 19, 20
    });

    it('honours maxRows before the end condition is reached', () => {
      const result = expand({
        frequency: RecurrenceFrequency.DAILY,
        count: 300,
        maxRows: 120,
      });

      expect(result).toHaveLength(120);
      expect(result.at(-1)?.index).toBe(119);
    });

    it('resumes from startIndex when topping a series up', () => {
      const result = expand({
        frequency: RecurrenceFrequency.DAILY,
        count: 10,
        startIndex: 7,
      });

      expect(result.map((o) => o.index)).toEqual([7, 8, 9]);
      expect(result[0].start.toISOString()).toBe('2026-08-24T09:00:00.000Z');
    });

    it('never exceeds the per-series ceiling, whatever the count says', () => {
      const result = expand({
        frequency: RecurrenceFrequency.DAILY,
        count: 100_000,
        maxRows: 100_000,
      });

      expect(result).toHaveLength(MAX_OCCURRENCES_PER_SERIES);
    });
  });

  describe('addUnits() — month-end clamping', () => {
    const jan31 = new Date('2026-01-31T09:00:00.000Z');

    it('pulls Jan 31 back to the last day of February', () => {
      expect(
        service
          .addUnits(jan31, RecurrenceFrequency.MONTHLY, 1)
          .toISOString(),
      ).toBe('2026-02-28T09:00:00.000Z');
    });

    it('clamps to Feb 29 in a leap year', () => {
      const jan31Leap = new Date('2028-01-31T09:00:00.000Z');
      expect(
        service
          .addUnits(jan31Leap, RecurrenceFrequency.MONTHLY, 1)
          .toISOString(),
      ).toBe('2028-02-29T09:00:00.000Z');
    });

    it('does not let the clamp accumulate — March is the 31st again', () => {
      // Each occurrence is computed from the anchor, so February borrowing a
      // shorter month must not drag every later month back with it.
      const result = service.expand({
        anchorStart: jan31,
        anchorEnd: new Date('2026-01-31T10:00:00.000Z'),
        frequency: RecurrenceFrequency.MONTHLY,
        count: 3,
        horizonEnd: FAR_FUTURE,
        maxRows: 100,
      });

      expect(result.map((o) => o.start.toISOString())).toEqual([
        '2026-01-31T09:00:00.000Z',
        '2026-02-28T09:00:00.000Z',
        '2026-03-31T09:00:00.000Z',
      ]);
    });

    it('clamps Feb 29 to Feb 28 on a non-leap year', () => {
      const feb29 = new Date('2028-02-29T09:00:00.000Z');
      expect(
        service.addUnits(feb29, RecurrenceFrequency.YEARLY, 1).toISOString(),
      ).toBe('2029-02-28T09:00:00.000Z');
    });

    it('carries a month overflow into the next year', () => {
      const nov30 = new Date('2026-11-30T09:00:00.000Z');
      expect(
        service.addUnits(nov30, RecurrenceFrequency.MONTHLY, 3).toISOString(),
      ).toBe('2027-02-28T09:00:00.000Z');
    });

    it('returns a copy, never the same instance, at n = 0', () => {
      const result = service.addUnits(jan31, RecurrenceFrequency.DAILY, 0);
      expect(result).not.toBe(jan31);
      expect(result.toISOString()).toBe(jan31.toISOString());
    });
  });
});
