import { BusinessBillingPeriod } from '@prisma/client';

/**
 * The end of a period that starts at `start`. Months are calendar months,
 * clamped: a monthly plan bought on 31 January ends on the last day of
 * February, not in March.
 */
export function periodEnd(
  start: Date,
  period: BusinessBillingPeriod,
  trialDays = 0,
): Date {
  if (period === BusinessBillingPeriod.TRIAL) {
    return new Date(start.getTime() + trialDays * 24 * 60 * 60 * 1000);
  }
  return addMonthsClamped(
    start,
    period === BusinessBillingPeriod.ANNUAL ? 12 : 1,
  );
}

function addMonthsClamped(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/**
 * When a new period starts: now, or — renewing early — when the latest
 * running or upcoming period ends, so paying early never loses days.
 */
export function nextPeriodStart(now: Date, latestEnd: Date | null): Date {
  return latestEnd && latestEnd > now ? latestEnd : now;
}

/** What a quota leaves. `null` quota: unlimited. */
export function remaining(quota: number | null, used: number): number | null {
  return quota === null ? null : Math.max(0, quota - used);
}

/** The price of a period for a plan. */
export function priceFor(
  plan: { monthly_price_fcfa: number; annual_price_fcfa: number },
  period: BusinessBillingPeriod,
): number {
  if (period === BusinessBillingPeriod.ANNUAL) return plan.annual_price_fcfa;
  if (period === BusinessBillingPeriod.MONTHLY) return plan.monthly_price_fcfa;
  return 0;
}

/**
 * Which reminder is due: the smallest configured lead time (in days) the
 * remaining time has fallen under, unless that reminder (or a later one) was
 * already sent.
 */
export function dueReminder(
  now: Date,
  endsAt: Date,
  reminderDays: number[],
  remindedAt: Date | null,
): number | null {
  const msLeft = endsAt.getTime() - now.getTime();
  if (msLeft <= 0) return null;
  const daysLeft = msLeft / (24 * 60 * 60 * 1000);
  const due = [...reminderDays]
    .sort((a, b) => a - b)
    .find((d) => daysLeft <= d);
  if (due === undefined) return null;
  if (remindedAt) {
    const sentDaysLeft =
      (endsAt.getTime() - remindedAt.getTime()) / (24 * 60 * 60 * 1000);
    // Already sent for this lead time (or a closer one).
    if (sentDaysLeft <= due) return null;
  }
  return due;
}

type PricedPlan = { monthly_price_fcfa: number; annual_price_fcfa: number };

/** A move to a dearer plan (by monthly price): it starts at once, not after the running one. */
export function isUpgrade(current: PricedPlan, next: PricedPlan): boolean {
  return next.monthly_price_fcfa > current.monthly_price_fcfa;
}

/**
 * Upgrading mid-period: what is left of the running period, at what it cost,
 * becomes extra time on the new plan at the new plan's rate — nothing paid is
 * lost. Returns the new period's end.
 */
export function upgradedEnd(
  now: Date,
  running: {
    starts_at: Date;
    ends_at: Date;
    plan: PricedPlan;
    billing_period: BusinessBillingPeriod;
  },
  next: { plan: PricedPlan; period: BusinessBillingPeriod },
): Date {
  const end = periodEnd(now, next.period);
  const spanOld = running.ends_at.getTime() - running.starts_at.getTime();
  const leftOld = running.ends_at.getTime() - now.getTime();
  const priceOld = priceFor(running.plan, running.billing_period);
  const priceNew = priceFor(next.plan, next.period);
  if (spanOld <= 0 || leftOld <= 0 || priceOld <= 0 || priceNew <= 0)
    return end;
  const credit = (priceOld * leftOld) / spanOld;
  const spanNew = end.getTime() - now.getTime();
  return new Date(end.getTime() + Math.round((credit / priceNew) * spanNew));
}
