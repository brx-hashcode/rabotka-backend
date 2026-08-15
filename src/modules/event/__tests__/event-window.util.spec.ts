import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_EVENT_DURATION_MINUTES,
  resolveEventWindow,
} from '../utils/event-window.util';

describe('resolveEventWindow', () => {
  const start = '2026-08-17T09:00:00.000Z';

  it('gives an omitted end the default duration', () => {
    // Not "runs forever": an occurrence with no end is a short one, and it is
    // the repeat rule that carries "this never stops".
    const { end } = resolveEventWindow(start);

    expect(end.toISOString()).toBe('2026-08-17T09:30:00.000Z');
    expect(DEFAULT_EVENT_DURATION_MINUTES).toBe(30);
  });

  it('treats a null end the same as an absent one', () => {
    expect(resolveEventWindow(start, null).end.toISOString()).toBe(
      '2026-08-17T09:30:00.000Z',
    );
  });

  it('keeps an explicit end', () => {
    const { start: s, end } = resolveEventWindow(
      start,
      '2026-08-17T10:30:00.000Z',
    );

    expect(s.toISOString()).toBe(start);
    expect(end.toISOString()).toBe('2026-08-17T10:30:00.000Z');
  });

  it('accepts Date instances, and copies them', () => {
    const startDate = new Date(start);
    const { start: s } = resolveEventWindow(startDate, new Date(start));

    expect(s).not.toBe(startDate);
    expect(s.toISOString()).toBe(start);
  });

  it('rejects an end before the start', () => {
    expect(() => resolveEventWindow(start, '2026-08-17T08:00:00.000Z')).toThrow(
      BadRequestException,
    );
  });

  it('rejects an unparseable date', () => {
    expect(() => resolveEventWindow('not a date')).toThrow(BadRequestException);
  });
});
