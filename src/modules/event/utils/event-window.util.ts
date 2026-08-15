import { BadRequestException } from '@nestjs/common';

/**
 * How long an event lasts when the caller does not say.
 *
 * There is no such thing as an event with no end — "this never ends" is a
 * property of the *repeat rule*, expressed by leaving its `until` and `count`
 * unset, not of the single occurrence. So an absent `endDate` means "the usual
 * short meeting", never "runs forever": a row with an end decades out would
 * cover every cell of every month it spans.
 */
export const DEFAULT_EVENT_DURATION_MINUTES = 30;

const MINUTE_MS = 60_000;

export type EventWindow = { start: Date; end: Date };

/**
 * The start and end of one occurrence, from what the caller sent.
 *
 * Both bounds are validated here rather than by a DTO decorator because they
 * are a cross-field rule, and because the same rule has to hold for an update,
 * where the new start may be paired with an end that was stored months ago.
 */
export function resolveEventWindow(
  startDate: string | Date,
  endDate?: string | Date | null,
): EventWindow {
  const start = toDate(startDate, 'startDate');
  const end =
    endDate === undefined || endDate === null
      ? new Date(start.getTime() + DEFAULT_EVENT_DURATION_MINUTES * MINUTE_MS)
      : toDate(endDate, 'endDate');

  if (end.getTime() < start.getTime()) {
    throw new BadRequestException('An event cannot end before it starts');
  }

  return { start, end };
}

function toDate(value: string | Date, field: string): Date {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} is not a valid date`);
  }
  return date;
}
