import { ApplicationStatus } from '@prisma/client';
import {
  cancellationScoreDeduction,
  cancellationSuspensionOutlook,
  countsTowardSuspension,
  isCommittedCancellation,
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
    'counts withdrawing a %s application too',
    (status) => {
      expect(countsTowardSuspension(status)).toBe(true);
    },
  );
});

describe('isCommittedCancellation', () => {
  it.each([
    ApplicationStatus.ACCEPTED,
    ApplicationStatus.WAITING_PAYMENT,
    ApplicationStatus.END,
  ])('is committed from %s — it costs reliability points', (status) => {
    expect(isCommittedCancellation(status)).toBe(true);
  });

  it.each([ApplicationStatus.PENDING, ApplicationStatus.VIEWED])(
    'a %s withdrawal is not — it costs no points',
    (status) => {
      expect(isCommittedCancellation(status)).toBe(false);
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

describe('cancellationScoreDeduction', () => {
  const base = { lateDeduction: 5, anyDeduction: 3 };

  it('adds both for a late cancellation of a committed mission', () => {
    expect(
      cancellationScoreDeduction({ ...base, late: true, committed: true }),
    ).toBe(8);
  });

  it('charges the any-cancellation points for an early one', () => {
    expect(
      cancellationScoreDeduction({ ...base, late: false, committed: true }),
    ).toBe(3);
  });

  it('costs nothing to withdraw a pending application early', () => {
    expect(
      cancellationScoreDeduction({ ...base, late: false, committed: false }),
    ).toBe(0);
  });

  it('treats an unset or negative setting as off', () => {
    expect(
      cancellationScoreDeduction({
        late: false,
        committed: true,
        lateDeduction: 5,
        anyDeduction: Number.NaN,
      }),
    ).toBe(0);
    expect(
      cancellationScoreDeduction({
        late: false,
        committed: true,
        lateDeduction: 5,
        anyDeduction: -2,
      }),
    ).toBe(0);
  });
});
