import { ApplicationStatus } from '@prisma/client';
import {
  cancellationSuspensionOutlook,
  countsTowardSuspension,
} from '../application.constants';

describe('countsTowardSuspension', () => {
  it.each([
    ApplicationStatus.ACCEPTED,
    ApplicationStatus.WAITING_PAYMENT,
    ApplicationStatus.END,
  ])('counts walking away from %s', (status) => {
    expect(countsTowardSuspension(status)).toBe(true);
  });

  it.each([ApplicationStatus.PENDING, ApplicationStatus.VIEWED])(
    'does not count withdrawing a %s application',
    (status) => {
      expect(countsTowardSuspension(status)).toBe(false);
    },
  );
});

describe('cancellationSuspensionOutlook', () => {
  it('suspends on the cancellation that reaches the threshold', () => {
    expect(
      cancellationSuspensionOutlook({
        priorInWindow: 2,
        counts: true,
        threshold: 3,
      }),
    ).toEqual({ afterThis: 3, wouldSuspend: true, remaining: 0 });
  });

  it('warns one short of it', () => {
    expect(
      cancellationSuspensionOutlook({
        priorInWindow: 1,
        counts: true,
        threshold: 3,
      }),
    ).toEqual({ afterThis: 2, wouldSuspend: false, remaining: 1 });
  });

  it('never suspends on a cancellation that does not count', () => {
    expect(
      cancellationSuspensionOutlook({
        priorInWindow: 5,
        counts: false,
        threshold: 3,
      }).wouldSuspend,
    ).toBe(false);
  });

  it('is off when the threshold is unset', () => {
    expect(
      cancellationSuspensionOutlook({
        priorInWindow: 9,
        counts: true,
        threshold: Number.NaN,
      }),
    ).toEqual({ afterThis: 10, wouldSuspend: false, remaining: null });
  });
});
