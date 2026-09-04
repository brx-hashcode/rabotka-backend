import {
  computeReferralPayout,
  referralPayoutSettingsFrom,
  ReferralPayoutSettings,
} from '../referral-payout';

const FIXED: ReferralPayoutSettings = {
  type: 'FIXED',
  referrerFcfa: 300,
  refereeFcfa: 200,
};

const SIXTY_FORTY: ReferralPayoutSettings = {
  type: 'PERCENTAGE',
  referrerPct: 60,
  refereePct: 40,
};

describe('referralPayoutSettingsFrom', () => {
  const STORED = {
    referrerCreditFcfa: 60,
    refereeCreditFcfa: 40,
    maxPayoutPerReferralFcfa: 500,
  };

  // The storage keys keep their `Fcfa` names in both modes, so this mapping is
  // the one place the stored numbers stop being francs and start being shares.
  it('reads the stored pair as percentages under PERCENTAGE', () => {
    expect(
      referralPayoutSettingsFrom({ ...STORED, commissionType: 'PERCENTAGE' }),
    ).toEqual({
      type: 'PERCENTAGE',
      referrerPct: 60,
      refereePct: 40,
      maxPayoutFcfa: 500,
    });
  });

  it('reads the same pair as francs under FIXED', () => {
    expect(
      referralPayoutSettingsFrom({ ...STORED, commissionType: 'FIXED' }),
    ).toEqual({
      type: 'FIXED',
      referrerFcfa: 60,
      refereeFcfa: 40,
      maxPayoutFcfa: 500,
    });
  });

  it('round-trips into a payout in both modes', () => {
    const stored = {
      referrerCreditFcfa: 60,
      refereeCreditFcfa: 40,
      maxPayoutPerReferralFcfa: 0,
    };
    expect(
      computeReferralPayout(
        1000,
        referralPayoutSettingsFrom({ ...stored, commissionType: 'PERCENTAGE' }),
      ),
    ).toMatchObject({ referrerAmount: 600, refereeAmount: 400 });
    expect(
      computeReferralPayout(
        1000,
        referralPayoutSettingsFrom({ ...stored, commissionType: 'FIXED' }),
      ),
    ).toMatchObject({ referrerAmount: 60, refereeAmount: 40 });
  });
});

describe('computeReferralPayout', () => {
  describe('FIXED', () => {
    it('pays the configured amounts, unscaled by the base', () => {
      expect(computeReferralPayout(500, FIXED)).toEqual({
        referrerAmount: 300,
        refereeAmount: 200,
        totalPayout: 500,
        shortfall: false,
      });
    });

    it('pays the same amounts on a larger base — that is the rigidity that motivated PERCENTAGE', () => {
      expect(computeReferralPayout(2000, FIXED)).toMatchObject({
        referrerAmount: 300,
        refereeAmount: 200,
      });
    });

    it('reports a shortfall when the payout would exceed the base', () => {
      // The money pump the old payout floor closed: a 100 FCFA worker unlock
      // buying 500 FCFA of credit.
      expect(computeReferralPayout(100, FIXED)).toMatchObject({
        totalPayout: 500,
        shortfall: true,
      });
    });

    it('does not report a shortfall when the base exactly covers the payout', () => {
      expect(computeReferralPayout(500, FIXED).shortfall).toBe(false);
    });

    it('rounds a fractional configured amount rather than passing it through', () => {
      expect(
        computeReferralPayout(1000, {
          type: 'FIXED',
          referrerFcfa: 300.6,
          refereeFcfa: 200.2,
        }),
      ).toMatchObject({ referrerAmount: 301, refereeAmount: 200 });
    });

    it('pays nothing when both amounts are zero — the program is off', () => {
      expect(
        computeReferralPayout(500, {
          type: 'FIXED',
          referrerFcfa: 0,
          refereeFcfa: 0,
        }),
      ).toEqual({
        referrerAmount: 0,
        refereeAmount: 0,
        totalPayout: 0,
        shortfall: false,
      });
    });
  });

  describe('PERCENTAGE', () => {
    it('splits the base 60/40', () => {
      expect(computeReferralPayout(500, SIXTY_FORTY)).toEqual({
        referrerAmount: 300,
        refereeAmount: 200,
        totalPayout: 500,
        shortfall: false,
      });
    });

    it('scales with the base, unlike FIXED', () => {
      expect(computeReferralPayout(1000, SIXTY_FORTY)).toMatchObject({
        referrerAmount: 600,
        refereeAmount: 400,
      });
    });

    it('pays nothing on a zero base without dividing by it', () => {
      expect(computeReferralPayout(0, SIXTY_FORTY)).toEqual({
        referrerAmount: 0,
        refereeAmount: 0,
        totalPayout: 0,
        shortfall: false,
      });
    });

    it('never reports a shortfall — the base bounds the payout structurally', () => {
      for (const base of [1, 7, 99, 333, 1000, 123457]) {
        expect(computeReferralPayout(base, SIXTY_FORTY).shortfall).toBe(false);
      }
    });
  });

  describe('rounding', () => {
    it('keeps the total within the base where independent rounding would not', () => {
      // 50% of 333 is 166.5. Rounded twice that is 167 + 167 = 334 — more than
      // came in. Floor-then-remainder gives 332, and the stray franc stays with
      // the platform.
      expect(
        computeReferralPayout(333, {
          type: 'PERCENTAGE',
          referrerPct: 50,
          refereePct: 50,
        }),
      ).toMatchObject({
        referrerAmount: 166,
        refereeAmount: 166,
        totalPayout: 332,
      });
    });

    it('pays nothing to either side when the base is too small to divide', () => {
      expect(computeReferralPayout(1, SIXTY_FORTY)).toMatchObject({
        referrerAmount: 0,
        refereeAmount: 0,
      });
    });

    it('holds referrer + referee <= base across a range of bases and splits', () => {
      const splits = [
        [60, 40],
        [50, 50],
        [70, 30],
        [33, 33],
        [1, 99],
        [100, 0],
        [0, 100],
      ];
      for (const [referrerPct, refereePct] of splits) {
        for (let base = 0; base <= 2000; base += 7) {
          const payout = computeReferralPayout(base, {
            type: 'PERCENTAGE',
            referrerPct,
            refereePct,
          });
          expect(payout.totalPayout).toBeLessThanOrEqual(base);
          expect(payout.referrerAmount).toBeGreaterThanOrEqual(0);
          expect(payout.refereeAmount).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  describe('misconfiguration is survivable, not fatal', () => {
    it('still keeps the total within the base when the percentages sum past 100', () => {
      // Validation on the admin write path is what stops this being saved. The
      // settlement path runs fire-and-forget, so it degrades instead of throwing.
      const payout = computeReferralPayout(1000, {
        type: 'PERCENTAGE',
        referrerPct: 80,
        refereePct: 80,
      });
      expect(payout.totalPayout).toBeLessThanOrEqual(1000);
      expect(payout).toMatchObject({ referrerAmount: 800, refereeAmount: 200 });
    });

    it('clamps a percentage above 100', () => {
      expect(
        computeReferralPayout(1000, {
          type: 'PERCENTAGE',
          referrerPct: 250,
          refereePct: 0,
        }),
      ).toMatchObject({ referrerAmount: 1000, refereeAmount: 0 });
    });

    it.each([
      ['negative', -50],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('treats a %s percentage as zero', (_label, referrerPct) => {
      expect(
        computeReferralPayout(1000, {
          type: 'PERCENTAGE',
          referrerPct,
          refereePct: 40,
        }),
      ).toMatchObject({ referrerAmount: 0, refereeAmount: 400 });
    });

    it.each([
      ['negative', -1],
      ['NaN', Number.NaN],
    ])('treats a %s base as zero', (_label, base) => {
      expect(computeReferralPayout(base, SIXTY_FORTY).totalPayout).toBe(0);
    });

    it('treats a negative fixed amount as zero rather than debiting anyone', () => {
      expect(
        computeReferralPayout(500, {
          type: 'FIXED',
          referrerFcfa: -300,
          refereeFcfa: 200,
        }),
      ).toMatchObject({ referrerAmount: 0, refereeAmount: 200 });
    });
  });

  describe('maxPayoutFcfa', () => {
    it('is off by default', () => {
      expect(computeReferralPayout(10_000, SIXTY_FORTY).totalPayout).toBe(
        10_000,
      );
    });

    it('is off when set to zero', () => {
      expect(
        computeReferralPayout(10_000, { ...SIXTY_FORTY, maxPayoutFcfa: 0 })
          .totalPayout,
      ).toBe(10_000);
    });

    it('does nothing when the payout already fits under it', () => {
      expect(
        computeReferralPayout(500, { ...SIXTY_FORTY, maxPayoutFcfa: 1000 }),
      ).toMatchObject({ referrerAmount: 300, refereeAmount: 200 });
    });

    it('scales both sides down, preserving the ratio', () => {
      expect(
        computeReferralPayout(10_000, { ...SIXTY_FORTY, maxPayoutFcfa: 1000 }),
      ).toMatchObject({
        referrerAmount: 600,
        refereeAmount: 400,
        totalPayout: 1000,
      });
    });

    it('never exceeds the cap, including where the ratio does not divide evenly', () => {
      for (const cap of [1, 7, 99, 333, 1001]) {
        const payout = computeReferralPayout(10_000, {
          type: 'PERCENTAGE',
          referrerPct: 70,
          refereePct: 30,
          maxPayoutFcfa: cap,
        });
        expect(payout.totalPayout).toBeLessThanOrEqual(cap);
      }
    });

    it('applies in FIXED mode too', () => {
      expect(
        computeReferralPayout(5000, { ...FIXED, maxPayoutFcfa: 100 }),
      ).toMatchObject({ totalPayout: 100 });
    });

    it('can bring a FIXED payout back under the base, clearing the shortfall', () => {
      // Deliberate: the invariant is "never issue more credit than the payment
      // brought in", and 50 out of 100 satisfies it. Only reachable when an
      // admin has explicitly set a cap — with the cap off this is the old
      // floor comparison unchanged.
      expect(
        computeReferralPayout(100, { ...FIXED, maxPayoutFcfa: 50 }),
      ).toMatchObject({ totalPayout: 50, shortfall: false });
    });
  });
});
