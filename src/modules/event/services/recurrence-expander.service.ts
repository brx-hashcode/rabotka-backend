import { Injectable } from '@nestjs/common';
import { RecurrenceFrequency } from '@prisma/client';

/**
 * Hard ceiling on how many occurrences one series may ever hold. A repeat rule
 * is a convenience, not a bulk-import tool — past a year of daily events the
 * calendar is unreadable anyway, and the cap keeps a typo ("every day, 100000
 * times") from becoming a database incident.
 */
export const MAX_OCCURRENCES_PER_SERIES = 365;

/** How many rows a single HTTP request will write. The rest is topped up later. */
export const MAX_MATERIALISED_PER_REQUEST = 120;

/** How far ahead a series with no end condition is generated. */
export const OPEN_ENDED_HORIZON_MONTHS = 12;

export type ExpandInput = {
  /** First occurrence — every later one is computed from this, not from its predecessor. */
  anchorStart: Date;
  anchorEnd: Date;
  frequency: RecurrenceFrequency;
  /** Inclusive last date. Mutually exclusive with `count`. */
  until?: Date | null;
  /** Total number of occurrences, counting the first. */
  count?: number | null;
  /** Never generate past this, whatever the rule says. */
  horizonEnd: Date;
  /** Stop after this many rows, so one request cannot write thousands. */
  maxRows: number;
  /** Where to resume when topping up an existing series. Defaults to 0. */
  startIndex?: number;
};

export type Occurrence = { start: Date; end: Date; index: number };

/**
 * Turns a repeat rule into concrete dates.
 *
 * Pure — no Prisma, no clock, no config — because this is where every date bug
 * in the feature would otherwise live. All arithmetic is on UTC components
 * rather than by adding milliseconds: `+ 86_400_000` is not "tomorrow" across a
 * DST boundary, it is "tomorrow, an hour earlier".
 */
@Injectable()
export class RecurrenceExpanderService {
  expand(input: ExpandInput): Occurrence[] {
    const {
      anchorStart,
      anchorEnd,
      frequency,
      until,
      count,
      horizonEnd,
      maxRows,
      startIndex = 0,
    } = input;

    // Preserved rather than recomputed per occurrence, so a 90-minute meeting
    // stays 90 minutes even when its start lands on a clamped month end.
    const durationMs = anchorEnd.getTime() - anchorStart.getTime();
    const hardLimit = count
      ? Math.min(count, MAX_OCCURRENCES_PER_SERIES)
      : MAX_OCCURRENCES_PER_SERIES;

    const occurrences: Occurrence[] = [];

    for (let index = startIndex; index < hardLimit; index++) {
      if (occurrences.length >= maxRows) break;

      const start = this.addUnits(anchorStart, frequency, index);
      if (until && start.getTime() > until.getTime()) break;
      if (start.getTime() > horizonEnd.getTime()) break;

      occurrences.push({
        start,
        end: new Date(start.getTime() + durationMs),
        index,
      });
    }

    return occurrences;
  }

  /**
   * `date` shifted by `n` periods.
   *
   * Monthly and yearly clamp to the end of the target month — Jan 31 + 1 month
   * is Feb 28 (or 29), not Mar 3. Because every occurrence is computed from the
   * anchor rather than from the one before it, that clamp never accumulates:
   * Jan 31 → Feb 28 → Mar 31, not Feb 28 → Mar 28.
   */
  addUnits(date: Date, frequency: RecurrenceFrequency, n: number): Date {
    if (n === 0) return new Date(date.getTime());

    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const time: [number, number, number, number] = [
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ];

    switch (frequency) {
      case RecurrenceFrequency.DAILY:
        return new Date(Date.UTC(year, month, day + n, ...time));
      case RecurrenceFrequency.WEEKLY:
        return new Date(Date.UTC(year, month, day + n * 7, ...time));
      case RecurrenceFrequency.MONTHLY:
        return this.shiftClamped(year, month + n, day, time);
      case RecurrenceFrequency.YEARLY:
        return this.shiftClamped(year + n, month, day, time);
    }
  }

  /** Same calendar day in another month/year, pulled back to the month's last day if it does not exist there. */
  private shiftClamped(
    year: number,
    month: number,
    day: number,
    time: [number, number, number, number],
  ): Date {
    // Date.UTC normalises an out-of-range month into the right year, so
    // `month + n` needs no manual carry.
    const normalised = new Date(Date.UTC(year, month, 1));
    const targetYear = normalised.getUTCFullYear();
    const targetMonth = normalised.getUTCMonth();
    const lastDay = new Date(
      Date.UTC(targetYear, targetMonth + 1, 0),
    ).getUTCDate();

    return new Date(
      Date.UTC(targetYear, targetMonth, Math.min(day, lastDay), ...time),
    );
  }

  /**
   * How long the gap is between the first occurrence and the second, in ms.
   *
   * Measured from the anchor rather than read off a table, because a period is
   * not a fixed length: the same MONTHLY rule steps 28 days from February and
   * 31 from March, and it is the step this anchor actually takes that an
   * occurrence has to fit inside.
   */
  intervalMs(anchorStart: Date, frequency: RecurrenceFrequency): number {
    return (
      this.addUnits(anchorStart, frequency, 1).getTime() - anchorStart.getTime()
    );
  }

  /** The horizon an open-ended series is generated up to, measured from its anchor. */
  openEndedHorizon(anchorStart: Date): Date {
    return this.addUnits(
      anchorStart,
      RecurrenceFrequency.MONTHLY,
      OPEN_ENDED_HORIZON_MONTHS,
    );
  }
}
