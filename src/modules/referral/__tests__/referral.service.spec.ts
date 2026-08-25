import {
  AccountStatus,
  Prisma,
  PaymentRequestStatus,
  PaymentRequestType,
  ReferralSource,
  ReferralStatus,
  VerificationStatus,
  WalletTransactionType,
} from '@prisma/client';
import { ReferralService } from '../referral.service';
import {
  generateReferralCode,
  normalizeReferralCode,
  REFERRAL_CODE_PATTERN,
} from '../utils/referral-code.util';

const REFERRER_ID = 'referrer-uuid-1';
const REFEREE_ID = 'referee-uuid-1';
const REFERRAL_ID = 'referral-uuid-1';
const PAYMENT_ID = 'payment-uuid-1';

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint', {
    code: 'P2002',
    clientVersion: '7.9.1',
  });
}

/** An eligible parrain: active and KYC-verified. */
const ELIGIBLE_REFERRER = {
  status: AccountStatus.ACTIVE,
  verification_status: VerificationStatus.VERIFIED,
  deleted_at: null,
};

/**
 * Let the fire-and-forget notification finish.
 *
 * settleForReferee deliberately does not await the email — the credit is
 * already committed and a mail failure must not make a settled parrainage look
 * unsettled. That is the behaviour under test, so the test waits instead of the
 * code doing it.
 */
const flushPromises = () => new Promise(setImmediate);

function makeTx() {
  return {
    referral: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    walletTransaction: { create: jest.fn().mockResolvedValue({}) },
    wallet: { update: jest.fn().mockResolvedValue({}) },
  };
}

describe('ReferralService', () => {
  let service: ReferralService;
  let prisma: any;
  let wallet: any;
  let systemConfig: any;
  let adminCache: any;
  let mail: any;
  let layout: any;
  let config: any;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    tx = makeTx();
    prisma = {
      profile: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
      referral: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
      },
      paymentRequest: { findFirst: jest.fn() },
      $transaction: jest.fn().mockImplementation((cb: any) => cb(tx)),
    };
    wallet = {
      getOrCreateProfileWallet: jest
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve({ id: `wallet-${id}`, balance: 0 }),
        ),
    };
    systemConfig = {
      getReferralCredits: jest.fn().mockResolvedValue({
        referrerCreditFcfa: 500,
        refereeCreditFcfa: 250,
        maxRewardedPerReferrer: 10,
      }),
    };
    adminCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    mail = { sendMail: jest.fn().mockResolvedValue(undefined) };
    layout = {
      wrap: jest.fn().mockImplementation((html: string) => Promise.resolve(html)),
    };
    config = { get: jest.fn().mockReturnValue('https://rabotka.work') };

    service = new ReferralService(
      prisma,
      wallet,
      systemConfig,
      adminCache,
      mail,
      layout,
      config,
    );
  });

  // ── Code generation ──────────────────────────────────────────────────────

  describe('generateReferralCode()', () => {
    it('emits codes matching the shared pattern, free of lookalike characters', () => {
      // Both members of each confusable pair are gone, which is the only
      // version of this that helps: keeping O while dropping 0 still leaves a
      // caller guessing which one they heard.
      for (let i = 0; i < 200; i++) {
        const code = generateReferralCode();
        expect(code).toMatch(REFERRAL_CODE_PATTERN);
        expect(code).not.toMatch(/[01OI]/);
      }
    });
  });

  describe('normalizeReferralCode()', () => {
    it('accepts what people actually paste and type', () => {
      expect(normalizeReferralCode(' k7m2xq ')).toBe('K7M2XQ');
      expect(normalizeReferralCode('K7M-2XQ')).toBe('K7M2XQ');
    });

    it('returns null for anything that could not be a code', () => {
      expect(normalizeReferralCode('K7M2X')).toBeNull(); // too short
      expect(normalizeReferralCode('K0M2XQ')).toBeNull(); // excluded 0
      expect(normalizeReferralCode(undefined)).toBeNull();
      expect(normalizeReferralCode(42)).toBeNull();
    });
  });

  describe('ensureReferralCode()', () => {
    it('returns the existing code without minting a new one', async () => {
      prisma.profile.findUnique.mockResolvedValue({ referral_code: 'AB23CD' });

      await expect(service.ensureReferralCode(REFERRER_ID)).resolves.toBe(
        'AB23CD',
      );
      expect(prisma.profile.update).not.toHaveBeenCalled();
    });

    it('retries on a unique collision and returns the code that landed', async () => {
      prisma.profile.findUnique.mockResolvedValue({ referral_code: null });
      prisma.profile.update
        .mockRejectedValueOnce(p2002())
        .mockRejectedValueOnce(p2002())
        .mockResolvedValueOnce({ referral_code: 'ZZ99YY' });

      await expect(service.ensureReferralCode(REFERRER_ID)).resolves.toBe(
        'ZZ99YY',
      );
      expect(prisma.profile.update).toHaveBeenCalledTimes(3);
    });

    it('rethrows a non-collision error instead of burning its retries', async () => {
      // The bug this guards: catching everything turns one dropped connection
      // into five wasted attempts and a fallback write that fails identically,
      // reported as a collision that never happened.
      prisma.profile.findUnique.mockResolvedValue({ referral_code: null });
      prisma.profile.update.mockRejectedValue(new Error('connection lost'));

      await expect(service.ensureReferralCode(REFERRER_ID)).rejects.toThrow(
        'connection lost',
      );
      expect(prisma.profile.update).toHaveBeenCalledTimes(1);
    });
  });

  // ── Signup ───────────────────────────────────────────────────────────────

  describe('recordReferral()', () => {
    it('records the relationship as PENDING and credits nothing', async () => {
      prisma.profile.findFirst.mockResolvedValue({ id: REFERRER_ID });
      prisma.referral.findFirst.mockResolvedValue(null);
      prisma.referral.create.mockResolvedValue({ id: REFERRAL_ID });

      await expect(
        service.recordReferral({
          refereeId: REFEREE_ID,
          code: 'K7M2XQ',
          source: ReferralSource.LINK,
        }),
      ).resolves.toBe(REFERRAL_ID);

      expect(prisma.referral.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            referrer_id: REFERRER_ID,
            referee_id: REFEREE_ID,
            code_used: 'K7M2XQ',
            status: ReferralStatus.PENDING,
          }),
        }),
      );
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('returns null for an unknown code rather than throwing', async () => {
      // The caller is a completed signup. A bad code must never cost an account.
      prisma.profile.findFirst.mockResolvedValue(null);

      await expect(
        service.recordReferral({ refereeId: REFEREE_ID, code: 'K7M2XQ' }),
      ).resolves.toBeNull();
      expect(prisma.referral.create).not.toHaveBeenCalled();
    });

    it('rejects a self-referral', async () => {
      prisma.profile.findFirst.mockResolvedValue({ id: REFEREE_ID });

      await expect(
        service.recordReferral({ refereeId: REFEREE_ID, code: 'K7M2XQ' }),
      ).resolves.toBeNull();
      expect(prisma.referral.create).not.toHaveBeenCalled();
    });

    it('rejects a circular referral', async () => {
      prisma.profile.findFirst.mockResolvedValue({ id: REFERRER_ID });
      prisma.referral.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(
        service.recordReferral({ refereeId: REFEREE_ID, code: 'K7M2XQ' }),
      ).resolves.toBeNull();
      expect(prisma.referral.create).not.toHaveBeenCalled();
    });
  });

  // ── Settlement ───────────────────────────────────────────────────────────

  describe('settleForReferee()', () => {
    function givenPendingReferral(overrides: Record<string, unknown> = {}) {
      prisma.referral.findUnique.mockResolvedValue({
        id: REFERRAL_ID,
        referrer_id: REFERRER_ID,
        status: ReferralStatus.PENDING,
        created_at: new Date(),
        ...overrides,
      });
    }

    function givenQualifyingPayment(amount: number) {
      prisma.paymentRequest.findFirst.mockResolvedValue({
        id: PAYMENT_ID,
        amount,
      });
    }

    it('credits both wallets once, tagged so admin can tell the sides apart', async () => {
      givenPendingReferral();
      givenQualifyingPayment(1000);
      prisma.profile.findUnique.mockResolvedValue(ELIGIBLE_REFERRER);

      await service.settleForReferee(REFEREE_ID);

      expect(tx.walletTransaction.create).toHaveBeenCalledTimes(2);
      const types = tx.walletTransaction.create.mock.calls.map(
        (c: any) => c[0].data.type,
      );
      expect(types).toEqual([
        WalletTransactionType.REFERRAL_CREDIT,
        WalletTransactionType.REFERRAL_CREDIT,
      ]);

      const refs = tx.walletTransaction.create.mock.calls.map(
        (c: any) => c[0].data.reference_type,
      );
      expect(refs.sort()).toEqual(['referral:referee', 'referral:referrer']);
      expect(tx.wallet.update).toHaveBeenCalledTimes(2);
    });

    it('only queries qualifying payment types — top-ups and penalties cannot trigger it', async () => {
      givenPendingReferral();
      prisma.paymentRequest.findFirst.mockResolvedValue(null);

      await service.settleForReferee(REFEREE_ID);

      expect(prisma.paymentRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: PaymentRequestStatus.APPROVED,
            request_type: {
              in: [
                PaymentRequestType.CONTACT_UNLOCK,
                PaymentRequestType.RECOMMENDATION_CONTACT,
              ],
            },
          }),
        }),
      );
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('ignores a wallet-funded unlock, which carries a null request_type', async () => {
      // ContactUnlockService.recordWalletUnlockPayment writes an APPROVED
      // PaymentRequest with contact_unlock_attempt_id set but NO request_type.
      // That null is the only thing keeping credit-funded unlocks out of the
      // program — paying a parrainage out of credit the platform itself issued
      // means the program funds itself from its own welcome bonuses.
      //
      // This test exists so that adding `request_type` over there fails here
      // instead of silently opening that door.
      givenPendingReferral();
      prisma.paymentRequest.findFirst.mockResolvedValue(null);

      await service.settleForReferee(REFEREE_ID);

      const where = prisma.paymentRequest.findFirst.mock.calls[0][0].where;
      expect(where.request_type).toEqual({
        in: [
          PaymentRequestType.CONTACT_UNLOCK,
          PaymentRequestType.RECOMMENDATION_CONTACT,
        ],
      });
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('writes nothing when another thread already claimed the referral', async () => {
      givenPendingReferral();
      givenQualifyingPayment(1000);
      prisma.profile.findUnique.mockResolvedValue(ELIGIBLE_REFERRER);
      tx.referral.updateMany.mockResolvedValue({ count: 0 });

      await service.settleForReferee(REFEREE_ID);

      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
      expect(tx.wallet.update).not.toHaveBeenCalled();
    });

    it('is a no-op once the referral is already REWARDED', async () => {
      givenPendingReferral({ status: ReferralStatus.REWARDED });

      await service.settleForReferee(REFEREE_ID);

      expect(prisma.paymentRequest.findFirst).not.toHaveBeenCalled();
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('updates the two wallets in a deterministic order', async () => {
      // Concurrent settlements share a parrain's wallet. Touching the pair in
      // caller order lets two transactions grab each other's rows in opposite
      // order, which is a deadlock, not a flake.
      givenPendingReferral();
      givenQualifyingPayment(1000);
      prisma.profile.findUnique.mockResolvedValue(ELIGIBLE_REFERRER);

      await service.settleForReferee(REFEREE_ID);

      const ids = tx.wallet.update.mock.calls.map((c: any) => c[0].where.id);
      expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    });

    describe('payout floor', () => {
      it('pays nothing when the payout would exceed the triggering payment', async () => {
        // 100 FCFA worker unlock against 500 + 250 of credit: the money pump
        // this floor exists to close.
        givenPendingReferral();
        givenQualifyingPayment(100);
        prisma.profile.findUnique.mockResolvedValue(ELIGIBLE_REFERRER);

        await service.settleForReferee(REFEREE_ID);

        expect(tx.walletTransaction.create).not.toHaveBeenCalled();
        expect(prisma.referral.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: ReferralStatus.CAPPED }),
          }),
        );
      });

      it('pays when the triggering payment exactly covers the payout', async () => {
        givenPendingReferral();
        givenQualifyingPayment(750);
        prisma.profile.findUnique.mockResolvedValue(ELIGIBLE_REFERRER);

        await service.settleForReferee(REFEREE_ID);

        expect(tx.walletTransaction.create).toHaveBeenCalledTimes(2);
      });
    });

    describe('referrer eligibility, evaluated at payout time', () => {
      it.each([
        [AccountStatus.PENDING_ACTIVATION, VerificationStatus.VERIFIED],
        [AccountStatus.SUSPENDED, VerificationStatus.VERIFIED],
        [AccountStatus.ACTIVE, VerificationStatus.PENDING],
        [AccountStatus.ACTIVE, VerificationStatus.REJECTED],
      ])('holds when referrer is %s / %s', async (status, verification) => {
        givenPendingReferral();
        givenQualifyingPayment(1000);
        prisma.profile.findUnique.mockResolvedValue({
          status,
          verification_status: verification,
          deleted_at: null,
        });

        await service.settleForReferee(REFEREE_ID);

        expect(tx.walletTransaction.create).not.toHaveBeenCalled();
        expect(prisma.referral.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: ReferralStatus.QUALIFIED_ON_HOLD,
            }),
          }),
        );
      });

      it('forfeits when the referrer is banned', async () => {
        givenPendingReferral();
        givenQualifyingPayment(1000);
        prisma.profile.findUnique.mockResolvedValue({
          status: AccountStatus.BANNED,
          verification_status: VerificationStatus.VERIFIED,
          deleted_at: null,
        });

        await service.settleForReferee(REFEREE_ID);

        expect(prisma.referral.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: ReferralStatus.FORFEITED }),
          }),
        );
      });

      it('forfeits when the referrer is soft-deleted', async () => {
        givenPendingReferral();
        givenQualifyingPayment(1000);
        prisma.profile.findUnique.mockResolvedValue({
          ...ELIGIBLE_REFERRER,
          deleted_at: new Date(),
        });

        await service.settleForReferee(REFEREE_ID);

        expect(tx.walletTransaction.create).not.toHaveBeenCalled();
      });

      it('forfeits a hold that has outlived the expiry window', async () => {
        const longAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
        givenPendingReferral({
          status: ReferralStatus.QUALIFIED_ON_HOLD,
          created_at: longAgo,
        });
        givenQualifyingPayment(1000);
        prisma.profile.findUnique.mockResolvedValue({
          status: AccountStatus.ACTIVE,
          verification_status: VerificationStatus.PENDING,
          deleted_at: null,
        });

        await service.settleForReferee(REFEREE_ID);

        expect(prisma.referral.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: ReferralStatus.FORFEITED }),
          }),
        );
      });
    });

    describe('cap', () => {
      it('caps at exactly the configured number of rewarded referrals', async () => {
        givenPendingReferral();
        givenQualifyingPayment(1000);
        prisma.profile.findUnique.mockResolvedValue(ELIGIBLE_REFERRER);
        prisma.referral.count.mockResolvedValue(10); // cap is 10

        await service.settleForReferee(REFEREE_ID);

        expect(tx.walletTransaction.create).not.toHaveBeenCalled();
        expect(prisma.referral.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: ReferralStatus.CAPPED }),
          }),
        );
      });

      it('still pays one below the cap', async () => {
        givenPendingReferral();
        givenQualifyingPayment(1000);
        prisma.profile.findUnique.mockResolvedValue(ELIGIBLE_REFERRER);
        prisma.referral.count.mockResolvedValue(9);

        await service.settleForReferee(REFEREE_ID);

        expect(tx.walletTransaction.create).toHaveBeenCalledTimes(2);
      });

      it('never counts against a null (unlimited) cap', async () => {
        givenPendingReferral();
        givenQualifyingPayment(1000);
        prisma.profile.findUnique.mockResolvedValue(ELIGIBLE_REFERRER);
        systemConfig.getReferralCredits.mockResolvedValue({
          referrerCreditFcfa: 500,
          refereeCreditFcfa: 250,
          maxRewardedPerReferrer: null,
        });

        await service.settleForReferee(REFEREE_ID);

        expect(prisma.referral.count).not.toHaveBeenCalled();
        expect(tx.walletTransaction.create).toHaveBeenCalledTimes(2);
      });
    });

    it('closes as REWARDED without wallet writes when both credits are zero', async () => {
      // Leaving it PENDING would mean switching the amounts on later silently
      // back-pays every referral ever recorded.
      givenPendingReferral();
      givenQualifyingPayment(1000);
      prisma.profile.findUnique.mockResolvedValue(ELIGIBLE_REFERRER);
      systemConfig.getReferralCredits.mockResolvedValue({
        referrerCreditFcfa: 0,
        refereeCreditFcfa: 0,
        maxRewardedPerReferrer: 10,
      });

      await service.settleForReferee(REFEREE_ID);

      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
      expect(prisma.referral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: ReferralStatus.REWARDED }),
        }),
      );
    });

    it('emails the parrain after the credit commits', async () => {
      givenPendingReferral();
      givenQualifyingPayment(1000);
      prisma.profile.findUnique
        .mockResolvedValueOnce(ELIGIBLE_REFERRER) // eligibility read
        .mockResolvedValueOnce({ first_name: 'Jean', email: 'jean@x.cg' })
        .mockResolvedValueOnce({ first_name: 'Awa' });

      await service.settleForReferee(REFEREE_ID);
      await flushPromises();

      expect(mail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'jean@x.cg' }),
      );
      // The filleul's name appears; the amount they paid must not.
      const html = layout.wrap.mock.calls[0][0];
      expect(html).toContain('Awa');
      expect(html).not.toContain('1 000');
    });

    it('still settles when the reward email fails', async () => {
      givenPendingReferral();
      givenQualifyingPayment(1000);
      prisma.profile.findUnique
        .mockResolvedValueOnce(ELIGIBLE_REFERRER)
        .mockResolvedValueOnce({ first_name: 'Jean', email: 'jean@x.cg' })
        .mockResolvedValueOnce({ first_name: 'Awa' });
      mail.sendMail.mockRejectedValue(new Error('smtp down'));

      await expect(
        service.settleForReferee(REFEREE_ID),
      ).resolves.toBeUndefined();
      await flushPromises();
      expect(tx.walletTransaction.create).toHaveBeenCalledTimes(2);
    });

    it('rounds a fractional configured amount rather than writing it raw', async () => {
      givenPendingReferral();
      givenQualifyingPayment(1000);
      prisma.profile.findUnique.mockResolvedValue(ELIGIBLE_REFERRER);
      systemConfig.getReferralCredits.mockResolvedValue({
        referrerCreditFcfa: 500.4,
        refereeCreditFcfa: 249.6,
        maxRewardedPerReferrer: 10,
      });

      await service.settleForReferee(REFEREE_ID);

      const amounts = tx.walletTransaction.create.mock.calls
        .map((c: any) => c[0].data.amount)
        .sort((a: number, b: number) => a - b);
      expect(amounts).toEqual([250, 500]);
    });
  });

  describe('getOwnReferralSummary()', () => {
    it('quotes a minimum equal to the floor the settle logic enforces', async () => {
      // These two numbers come from one function on purpose. If they ever
      // diverge, the screen promises a credit the backend then declines — the
      // single worst outcome this feature has.
      prisma.referral.findUnique.mockResolvedValue(null);
      prisma.profile.findUnique.mockResolvedValue({ referral_code: 'AB23CD' });

      const summary = await service.getOwnReferralSummary(REFERRER_ID);

      expect(summary.minQualifyingAmountFcfa).toBe(
        summary.referrerCreditFcfa + summary.refereeCreditFcfa,
      );
    });

    it('reports sanitized amounts, not the raw config values', async () => {
      prisma.referral.findUnique.mockResolvedValue(null);
      prisma.profile.findUnique.mockResolvedValue({ referral_code: 'AB23CD' });
      systemConfig.getReferralCredits.mockResolvedValue({
        referrerCreditFcfa: 300.4,
        refereeCreditFcfa: 199.6,
        maxRewardedPerReferrer: 10,
      });

      const summary = await service.getOwnReferralSummary(REFERRER_ID);

      expect(summary.referrerCreditFcfa).toBe(300);
      expect(summary.refereeCreditFcfa).toBe(200);
      expect(summary.minQualifyingAmountFcfa).toBe(500);
    });
  });

  describe('settleHeldForReferrer()', () => {
    it('replays settlement for every referee held on this parrain', async () => {
      prisma.referral.findMany.mockResolvedValue([
        { referee_id: 'referee-a' },
        { referee_id: 'referee-b' },
      ]);
      const settle = jest
        .spyOn(service, 'settleForReferee')
        .mockResolvedValue(undefined);

      await service.settleHeldForReferrer(REFERRER_ID);

      expect(settle).toHaveBeenCalledWith('referee-a');
      expect(settle).toHaveBeenCalledWith('referee-b');
    });

    it('keeps going when one referee fails', async () => {
      prisma.referral.findMany.mockResolvedValue([
        { referee_id: 'referee-a' },
        { referee_id: 'referee-b' },
      ]);
      const settle = jest
        .spyOn(service, 'settleForReferee')
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(undefined);

      await expect(
        service.settleHeldForReferrer(REFERRER_ID),
      ).resolves.toBeUndefined();
      expect(settle).toHaveBeenCalledTimes(2);
    });
  });

  describe('resolveCode()', () => {
    it('returns a first name and an initial, never contact details', async () => {
      prisma.profile.findFirst.mockResolvedValue({
        first_name: 'Jean',
        last_name: 'Dupont',
      });

      await expect(service.resolveCode('k7m2xq')).resolves.toEqual({
        firstName: 'Jean',
        lastInitial: 'D',
      });
    });

    it('returns null for a malformed code without querying', async () => {
      await expect(service.resolveCode('nope')).resolves.toBeNull();
      expect(prisma.profile.findFirst).not.toHaveBeenCalled();
    });

    it('excludes banned and soft-deleted owners', async () => {
      prisma.profile.findFirst.mockResolvedValue(null);

      await service.resolveCode('K7M2XQ');

      expect(prisma.profile.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deleted_at: null,
            status: { notIn: [AccountStatus.BANNED] },
          }),
        }),
      );
    });
  });
});
