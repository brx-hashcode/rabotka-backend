/**
 * Stage 2 of a parrainage settlement: how much each side gets.
 *
 * Pure by construction — no Prisma, no config reads, no clock, no I/O. Stage 1
 * (the qualification gate, in ReferralService) decides *whether* anything is
 * owed and produces the base; this decides *how much*, and it is the only part
 * of the program that branches on the commission type.
 *
 * That split is load-bearing rather than tidy. The anti-farming rules all live
 * in the gate, so an admin flipping the type in settings cannot open a path the
 * other type closes — there is no rule here for a type switch to bypass.
 */

const PERCENT_BASE = 100;

export type ReferralCommissionType = 'FIXED' | 'PERCENTAGE';

type PayoutCap = {
  /**
   * Absolute ceiling on the combined payout, 0 for "no cap".
   *
   * Not redundant with the base in PERCENTAGE mode: the base is a number the
   * admin never types and only sees after the fact, so a mis-set connection fee
   * would issue credit quietly rather than visibly. This is the number they can
   * reason about without knowing what anyone paid.
   */
  maxPayoutFcfa?: number;
};

export type ReferralPayoutSettings =
  | ({ type: 'FIXED'; referrerFcfa: number; refereeFcfa: number } & PayoutCap)
  | ({
      type: 'PERCENTAGE';
      referrerPct: number;
      refereePct: number;
    } & PayoutCap);

export type ReferralPayout = {
  referrerAmount: number;
  refereeAmount: number;
  totalPayout: number;
  /**
   * The payout does not fit inside the base — pay nothing.
   *
   * Only reachable in FIXED mode, where the amounts are absolute and know
   * nothing about what was actually paid. This is the old "payout floor" rule,
   * moved out of the gate and turned into a fact about the amount: the caller
   * maps it to CAPPED, so the admin-visible outcome is unchanged.
   *
   * In PERCENTAGE mode it is always false, and not by luck — see
   * {@link percentageShares}.
   */
  shortfall: boolean;
};

/**
 * The parrainage settings as stored — the shape
 * `SystemConfigService.getReferralCredits()` returns.
 *
 * Declared structurally rather than imported so this module stays free of any
 * dependency on the config layer: it is the one piece of the settlement that
 * can be reasoned about, and tested, without a database or a Redis.
 */
export type ReferralCreditsConfig = {
  commissionType: ReferralCommissionType;
  referrerCreditFcfa: number;
  refereeCreditFcfa: number;
  maxPayoutPerReferralFcfa?: number;
};

/**
 * Config → settings. One place, because this is where the stored numbers stop
 * being francs and start being percentages, and a second copy of that decision
 * is a settlement that pays in a unit the screen is not describing.
 *
 * The storage keys keep their `Fcfa` names in both modes (see
 * `getReferralCredits`), so this is also the line that documents the switch.
 */
export function referralPayoutSettingsFrom(
  credits: ReferralCreditsConfig,
): ReferralPayoutSettings {
  const maxPayoutFcfa = credits.maxPayoutPerReferralFcfa;
  return credits.commissionType === 'PERCENTAGE'
    ? {
        type: 'PERCENTAGE',
        referrerPct: credits.referrerCreditFcfa,
        refereePct: credits.refereeCreditFcfa,
        maxPayoutFcfa,
      }
    : {
        type: 'FIXED',
        referrerFcfa: credits.referrerCreditFcfa,
        refereeFcfa: credits.refereeCreditFcfa,
        maxPayoutFcfa,
      };
}

/**
 * Split `baseFcfa` between the two sides.
 *
 * `baseFcfa` is the real-money amount that triggered the settlement. Today that
 * is always the full amount of a mobile-money payment; when wallet-funded
 * unlocks start qualifying it becomes the real-money portion of one, and
 * nothing in this function has to change for that.
 */
export function computeReferralPayout(
  baseFcfa: number,
  settings: ReferralPayoutSettings,
): ReferralPayout {
  const base = sanitizeAmount(baseFcfa);

  const shares =
    settings.type === 'FIXED'
      ? fixedShares(settings)
      : percentageShares(base, settings);

  const { referrerAmount, refereeAmount } = applyCap(
    shares,
    settings.maxPayoutFcfa,
  );
  const totalPayout = referrerAmount + refereeAmount;

  return {
    referrerAmount,
    refereeAmount,
    totalPayout,
    // Checked after the cap, not before: the invariant that matters is "never
    // issue more credit than the payment brought in", and a capped payout that
    // fits satisfies it. With the cap off — the default — this is exactly the
    // pre-existing floor comparison.
    shortfall: totalPayout > base,
  };
}

/**
 * Absolute amounts, unscaled by the base. `Math.round`, not floor, because this
 * is the arithmetic the fixed-mode program has always used and a config value
 * an admin typed as `300.6` has always become 301.
 */
function fixedShares(settings: {
  referrerFcfa: number;
  refereeFcfa: number;
}): Shares {
  return {
    referrerAmount: sanitizeAmount(settings.referrerFcfa),
    refereeAmount: sanitizeAmount(settings.refereeFcfa),
  };
}

/**
 * Percentages of the base, floored, with the referee taking the remainder.
 *
 * Rounding each share independently would break the one invariant this mode
 * exists to guarantee: 50/50 of 333 rounds to 167 + 167 = 334, which is more
 * than came in. So the referrer's share is floored and the referee is capped at
 * whatever is left — 166 + 166 = 332 for that case. The stray franc stays with
 * the platform, which is the right direction for credit issued against revenue
 * already collected.
 *
 * The `min` is also what makes a misconfigured pair (summing past 100) safe
 * without depending on validation upstream having run.
 */
function percentageShares(
  base: number,
  settings: { referrerPct: number; refereePct: number },
): Shares {
  const referrerAmount = Math.floor(
    (base * sanitizePercent(settings.referrerPct)) / PERCENT_BASE,
  );
  return {
    referrerAmount,
    refereeAmount: Math.min(
      Math.floor((base * sanitizePercent(settings.refereePct)) / PERCENT_BASE),
      base - referrerAmount,
    ),
  };
}

/**
 * Scale both sides down to fit under the cap, preserving their ratio.
 *
 * Same floor-then-remainder discipline as the percentage split, for the same
 * reason: two independently rounded shares can add up past the ceiling they
 * were supposed to fit under.
 */
function applyCap(shares: Shares, maxPayoutFcfa: number | undefined): Shares {
  const cap = sanitizeAmount(maxPayoutFcfa ?? 0);
  const total = shares.referrerAmount + shares.refereeAmount;
  if (cap === 0 || total <= cap) return shares;

  // total > cap >= 1 here, so the division is safe.
  const referrerAmount = Math.floor((shares.referrerAmount * cap) / total);
  return {
    referrerAmount,
    refereeAmount: Math.min(shares.refereeAmount, cap - referrerAmount),
  };
}

type Shares = { referrerAmount: number; refereeAmount: number };

/**
 * Config values arrive as strings an admin typed. FCFA has no minor unit, so
 * round; a negative or unparseable amount means the config is broken, and the
 * right answer in a settlement path is to pay nothing rather than to throw.
 */
function sanitizeAmount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

/**
 * Percentages are integers, 0-100, clamped rather than rejected.
 *
 * Clamping over throwing for the same reason as {@link sanitizeAmount}: this
 * runs inside a fire-and-forget settlement, so an out-of-range value has to
 * degrade to a defensible payout instead of vanishing into a log. Validation on
 * the admin write path is what actually stops the value being saved.
 */
function sanitizePercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.round(value), PERCENT_BASE);
}
