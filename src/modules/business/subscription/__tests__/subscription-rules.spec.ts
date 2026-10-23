import {
  dueReminder,
  nextPeriodStart,
  periodEnd,
  priceFor,
  remaining,
} from '../subscription-rules';

const d = (iso: string) => new Date(iso);

describe('periodEnd', () => {
  it('adds a calendar month', () => {
    expect(periodEnd(d('2026-03-15T10:00:00Z'), 'MONTHLY')).toEqual(
      d('2026-04-15T10:00:00Z'),
    );
  });
  it('clamps to the end of a shorter month', () => {
    expect(periodEnd(d('2026-01-31T10:00:00Z'), 'MONTHLY')).toEqual(
      d('2026-02-28T10:00:00Z'),
    );
  });
  it('adds twelve months for annual', () => {
    expect(periodEnd(d('2026-10-23T00:00:00Z'), 'ANNUAL')).toEqual(
      d('2027-10-23T00:00:00Z'),
    );
  });
  it('adds the trial days', () => {
    expect(periodEnd(d('2026-10-01T00:00:00Z'), 'TRIAL', 14)).toEqual(
      d('2026-10-15T00:00:00Z'),
    );
  });
});

describe('nextPeriodStart', () => {
  const now = d('2026-10-23T00:00:00Z');
  it('starts now without a running period', () => {
    expect(nextPeriodStart(now, null)).toEqual(now);
    expect(nextPeriodStart(now, d('2026-10-01T00:00:00Z'))).toEqual(now);
  });
  it('stacks after a running period, so renewing early loses nothing', () => {
    expect(nextPeriodStart(now, d('2026-11-05T00:00:00Z'))).toEqual(
      d('2026-11-05T00:00:00Z'),
    );
  });
});

describe('quotas and prices', () => {
  it('treats null as unlimited and never goes negative', () => {
    expect(remaining(null, 50)).toBeNull();
    expect(remaining(10, 3)).toBe(7);
    expect(remaining(10, 12)).toBe(0);
  });
  it('prices by period', () => {
    const plan = { monthly_price_fcfa: 100, annual_price_fcfa: 1000 };
    expect(priceFor(plan, 'MONTHLY')).toBe(100);
    expect(priceFor(plan, 'ANNUAL')).toBe(1000);
    expect(priceFor(plan, 'TRIAL')).toBe(0);
  });
});

describe('dueReminder', () => {
  const end = d('2026-11-10T00:00:00Z');
  it('is not due far from the end', () => {
    expect(
      dueReminder(d('2026-10-20T00:00:00Z'), end, [7, 1], null),
    ).toBeNull();
  });
  it('fires the 7-day reminder, then the 1-day one, once each', () => {
    const sixDaysLeft = d('2026-11-04T00:00:00Z');
    expect(dueReminder(sixDaysLeft, end, [7, 1], null)).toBe(7);
    expect(
      dueReminder(d('2026-11-05T00:00:00Z'), end, [7, 1], sixDaysLeft),
    ).toBeNull();
    const halfDayLeft = d('2026-11-09T12:00:00Z');
    expect(dueReminder(halfDayLeft, end, [7, 1], sixDaysLeft)).toBe(1);
    expect(
      dueReminder(d('2026-11-09T18:00:00Z'), end, [7, 1], halfDayLeft),
    ).toBeNull();
  });
  it('is never due once ended', () => {
    expect(
      dueReminder(d('2026-11-11T00:00:00Z'), end, [7, 1], null),
    ).toBeNull();
  });
});
