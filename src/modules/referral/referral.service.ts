import { appUrlFor, audienceOf, productOf } from '../mail/audience';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountStatus,
  Prisma,
  PaymentRequestStatus,
  PaymentRequestType,
  ReferralSource,
  ReferralStatus,
  VerificationStatus,
  WalletOwnerType,
  WalletTransactionType,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { AdminCacheService } from '../../common/services/cache/admin-cache.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';
import { MailService } from '../mail/mail.service';
import { LayoutService } from '../mail/layout.service';
import {
  referralRewardedEmail,
  REFERRAL_REWARDED_EMAIL_PREVIEW,
} from '../mail/templates';
import { AdminListReferralsDto } from './dto/admin-list-referrals.dto';
import {
  computeReferralPayout,
  referralPayoutSettingsFrom,
} from './referral-payout';
import {
  generateReferralCode,
  normalizeReferralCode,
} from './utils/referral-code.util';

type AdminPartyRow = {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  profile_type: string;
};

function toAdminParty(p: AdminPartyRow) {
  return {
    profileId: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    phone: p.phone,
    profileType: p.profile_type,
  };
}

/**
 * How long a QUALIFIED_ON_HOLD referral waits for its parrain to get verified
 * before it is written off.
 *
 * Not a config key on purpose: it exists only to stop held rows accumulating
 * forever, and no admin has a reason to tune it. The money was already
 * collected into the system wallet when the filleul paid, so a held row costs
 * nothing while it waits — this is housekeeping, not policy.
 */
const HOLD_EXPIRY_DAYS = 90;

/** Attempts before falling back to a longer, collision-proof code. */
const MINT_ATTEMPTS = 5;

/**
 * The payment types that count as "a connection" for parrainage.
 *
 * Kept in sync with `src/common/queries/paid-contacts.sql.ts`, which defines
 * the same idea for the collaboration graph. Wallet-credit-paid unlocks are
 * absent by construction rather than by filter — see the call site in
 * PaymentRequestService.processSuccessfulPayment.
 */
const QUALIFYING_PAYMENT_TYPES: PaymentRequestType[] = [
  PaymentRequestType.CONTACT_UNLOCK,
  PaymentRequestType.RECOMMENDATION_CONTACT,
];

export type RecordReferralInput = {
  refereeId: string;
  code: string;
  source?: ReferralSource;
};

/**
 * The outcome of stage 1 — see {@link ReferralService.qualifyForSettlement}.
 *
 * The rejection arm carries nothing because there is nothing for the caller to
 * do with it: the gate has already written the status and the note that explain
 * the refusal, and every rejection is a silent stop by design (this runs
 * fire-and-forget behind a payment).
 */
type ReferralQualification =
  | { qualifies: false }
  | {
      qualifies: true;
      referralId: string;
      referrerId: string;
      qualifyingPaymentRequestId: string;
      /** What the payout may be divided from, in whole FCFA. */
      realMoneyBaseFcfa: number;
      credits: Awaited<ReturnType<SystemConfigService['getReferralCredits']>>;
    };

const NOT_QUALIFIED: ReferralQualification = { qualifies: false };

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly systemConfig: SystemConfigService,
    private readonly adminCache: AdminCacheService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly config: ConfigService,
  ) {}

  // ── Codes ─────────────────────────────────────────────────────────────────

  /**
   * Return this profile's parrainage code, minting one on first ask.
   *
   * Lazy like `PortfolioService.ensurePortfolioSlug`, and for the same reason:
   * a code nobody has shared is a code nobody can type, so there is nothing to
   * gain from backfilling the whole profile table.
   */
  async ensureReferralCode(profileId: string): Promise<string> {
    const existing = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { referral_code: true },
    });
    if (existing?.referral_code) return existing.referral_code;

    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      try {
        const updated = await this.prisma.profile.update({
          where: { id: profileId },
          data: { referral_code: generateReferralCode() },
          select: { referral_code: true },
        });
        return updated.referral_code!;
      } catch (err) {
        // Only a unique collision is worth another spin. Catching everything
        // here — as ensurePortfolioSlug does — turns one dropped connection
        // into five wasted attempts and then a "fallback" write that fails the
        // same way, reported as a collision that never happened.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue;
        }
        throw err;
      }
    }

    // 32**6 makes five collisions in a row essentially impossible, so reaching
    // here means the assumption is wrong somewhere. Widen the space rather
    // than fail the caller.
    const fallback = `${generateReferralCode()}${generateReferralCode()}`;
    const updated = await this.prisma.profile.update({
      where: { id: profileId },
      data: { referral_code: fallback },
      select: { referral_code: true },
    });
    return updated.referral_code!;
  }

  /**
   * Resolve a code to the profile that owns it, for the live check on the
   * signup screen. Returns null for unknown, malformed, deleted and banned —
   * the caller shows the same "code introuvable" for all of them.
   */
  async resolveCode(
    rawCode: string,
  ): Promise<{ firstName: string; lastInitial: string } | null> {
    const code = normalizeReferralCode(rawCode);
    if (!code) return null;

    const referrer = await this.prisma.profile.findFirst({
      where: {
        referral_code: code,
        deleted_at: null,
        status: { notIn: [AccountStatus.BANNED] },
      },
      select: { first_name: true, last_name: true },
    });
    if (!referrer) return null;

    // A first name and an initial. Enough for "yes, that's my friend", and not
    // enough to turn a throttled endpoint into a directory of the user base.
    return {
      firstName: referrer.first_name,
      lastInitial: referrer.last_name.charAt(0).toUpperCase(),
    };
  }

  // ── Signup ────────────────────────────────────────────────────────────────

  /**
   * Record who referred a newly created profile. Credits nothing — payout
   * happens on the filleul's first mobile-money payment for a connection.
   *
   * Returns null for every rejection rather than throwing. The caller is a
   * completed signup, and there is nothing useful it can do with "that code
   * does not exist" except log it: a bad code must never cost an account.
   */
  async recordReferral(input: RecordReferralInput): Promise<string | null> {
    const code = normalizeReferralCode(input.code);
    if (!code) return null;

    const referrer = await this.prisma.profile.findFirst({
      where: {
        referral_code: code,
        deleted_at: null,
        status: { notIn: [AccountStatus.BANNED] },
      },
      select: { id: true },
    });
    if (!referrer) {
      this.logger.log(`Referral code ${code} did not resolve — ignoring`);
      return null;
    }

    if (referrer.id === input.refereeId) {
      this.logger.warn(`Self-referral attempt by profile=${input.refereeId}`);
      return null;
    }

    // Unreachable today: attribution only happens at signup, and a profile
    // created seconds ago has referred nobody. Kept because it is one indexed
    // read, and because it is the invariant that stays true if we ever let an
    // admin attach a referral after the fact.
    const reciprocal = await this.prisma.referral.findFirst({
      where: { referrer_id: input.refereeId, referee_id: referrer.id },
      select: { id: true },
    });
    if (reciprocal) {
      this.logger.warn(
        `Circular referral blocked: ${referrer.id} <-> ${input.refereeId}`,
      );
      return null;
    }

    try {
      const referral = await this.prisma.referral.create({
        data: {
          referrer_id: referrer.id,
          referee_id: input.refereeId,
          code_used: code,
          source: input.source ?? ReferralSource.LINK,
          status: ReferralStatus.PENDING,
        },
        select: { id: true },
      });
      await this.adminCache.invalidate('referrals');
      return referral.id;
    } catch (err) {
      // referee_id is unique: this profile was already attributed. Not an
      // error worth surfacing — the first attribution wins.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return null;
      }
      throw err;
    }
  }

  // ── Settlement ────────────────────────────────────────────────────────────

  /**
   * Decide and settle the parrainage for one filleul.
   *
   * Takes a profile, not a payment, and re-reads every fact it needs from the
   * database. That is what makes it replayable: the payment hook calls it
   * fire-and-forget, `verifyKyc` calls it when a held parrain is approved, and
   * `GET /referral/me` calls it so the person who cares about the money does
   * the recovery just by opening the screen. Calling it twice is free.
   */
  async settleForReferee(refereeId: string): Promise<void> {
    const gate = await this.qualifyForSettlement(refereeId);
    if (!gate.qualifies) return;

    // Stage 2. The only place the commission type is consulted, and the only
    // arithmetic in the whole settlement — everything that decides *whether*
    // anyone is paid has happened above, identically for every type.
    const payout = computeReferralPayout(
      gate.realMoneyBaseFcfa,
      referralPayoutSettingsFrom(gate.credits),
    );

    // The program must never pay out more than the payment that triggered it
    // brought in. Without this, the cheapest qualifying payment — a worker-side
    // contact unlock, 100 FCFA by default — buys strictly more credit than it
    // costs, and the cap only bounds how many times that can be repeated.
    //
    // A property of the amount rather than a gate, because it is one: in
    // PERCENTAGE mode it can never be true, and a rule that only exists for one
    // commission type does not belong among the ones that must hold for all of
    // them. The admin-visible outcome is unchanged — still CAPPED, still the
    // same note.
    if (payout.shortfall) {
      await this.close(
        gate.referralId,
        ReferralStatus.CAPPED,
        gate.qualifyingPaymentRequestId,
        `Paiement déclencheur (${gate.realMoneyBaseFcfa} FCFA) inférieur au total des crédits (${payout.totalPayout} FCFA).`,
      );
      return;
    }

    if (payout.totalPayout === 0) {
      // Both credits configured to zero: the program is off. Close the row as
      // settled-for-nothing rather than leaving it PENDING, so switching the
      // amounts back on later does not silently back-pay every referral ever
      // recorded.
      await this.close(
        gate.referralId,
        ReferralStatus.REWARDED,
        gate.qualifyingPaymentRequestId,
        'Montants de parrainage à zéro au moment du règlement.',
        { referrerAmount: 0, refereeAmount: 0 },
      );
      return;
    }

    // Resolve both wallets before opening the transaction — upserting inside it
    // would hold the referral row lock across two more writes for no reason.
    const referrerWallet = await this.wallet.getOrCreateProfileWallet(
      gate.referrerId,
    );
    const refereeWallet = await this.wallet.getOrCreateProfileWallet(refereeId);

    const credits = [
      {
        walletId: referrerWallet.id,
        amount: payout.referrerAmount,
        referenceType: 'referral:referrer',
      },
      {
        walletId: refereeWallet.id,
        amount: payout.refereeAmount,
        referenceType: 'referral:referee',
      },
    ]
      // Sorted by wallet id, not referrer-then-referee. Two settlements that
      // share a parrain touch overlapping wallet pairs, and touching them in
      // caller order lets two transactions grab each other's rows in opposite
      // order — a textbook Postgres deadlock, under exactly the concurrency
      // this feature invites.
      .sort((a, b) => a.walletId.localeCompare(b.walletId));

    await this.prisma.$transaction(async (tx) => {
      // Atomic claim, same shape as WalletService.grantWelcomeCredit: only one
      // caller can move the row out of PENDING/QUALIFIED_ON_HOLD, and the loser
      // writes nothing. This is also what makes "first qualifying payment"
      // true without counting payments — a second one finds nothing to claim.
      const claim = await tx.referral.updateMany({
        where: {
          id: gate.referralId,
          status: {
            in: [ReferralStatus.PENDING, ReferralStatus.QUALIFIED_ON_HOLD],
          },
        },
        data: {
          status: ReferralStatus.REWARDED,
          rewarded_at: new Date(),
          referrer_amount: payout.referrerAmount,
          referee_amount: payout.refereeAmount,
          qualifying_payment_request_id: gate.qualifyingPaymentRequestId,
          settlement_note: null,
        },
      });
      if (claim.count === 0) return;

      for (const credit of credits) {
        await tx.walletTransaction.create({
          data: {
            wallet_id: credit.walletId,
            type: WalletTransactionType.REFERRAL_CREDIT,
            amount: credit.amount,
            reference_type: credit.referenceType,
            reference_id: gate.referralId,
          },
        });
        await tx.wallet.update({
          where: { id: credit.walletId },
          data: { balance: { increment: credit.amount } },
        });
      }
    });

    await Promise.all([
      this.adminCache.invalidate('referrals'),
      this.adminCache.invalidate('wallet-transactions'),
    ]);

    this.logger.log(
      `Referral ${gate.referralId} rewarded: ${payout.referrerAmount} FCFA to referrer, ` +
        `${payout.refereeAmount} FCFA to referee, triggered by payment ${gate.qualifyingPaymentRequestId}`,
    );

    // Fire-and-forget: the credit is already committed, and a mail failure must
    // not make a settled parrainage look unsettled to the caller.
    void this.notifyReferrer(gate.referrerId, refereeId, payout.referrerAmount);
  }

  /**
   * Stage 1: does this filleul's parrainage owe anyone anything, and on what
   * base?
   *
   * Every anti-farming rule lives here and none of them consults the commission
   * type, so switching FIXED ⇄ PERCENTAGE in settings cannot open a path the
   * other type closed. Stage 2 only divides a number this already approved.
   *
   * Closes the referral row itself on every rejection — the note it writes is
   * the only thing that can answer "why was my parrainage not paid?", and the
   * caller has no more context to write a better one with.
   *
   * Returns the config it loaded rather than making the caller re-read it: the
   * cap needs `maxRewardedPerReferrer` here, and a second read for the amounts
   * would be a second chance for the two stages to disagree about the settings
   * a single settlement ran under.
   */
  private async qualifyForSettlement(
    refereeId: string,
  ): Promise<ReferralQualification> {
    const referral = await this.prisma.referral.findUnique({
      where: { referee_id: refereeId },
      select: {
        id: true,
        referrer_id: true,
        status: true,
        created_at: true,
      },
    });
    if (!referral) return NOT_QUALIFIED;
    if (
      referral.status !== ReferralStatus.PENDING &&
      referral.status !== ReferralStatus.QUALIFIED_ON_HOLD
    ) {
      return NOT_QUALIFIED;
    }

    // Two shapes of connection qualify, and they are told apart by
    // `request_type` rather than by a flag:
    //
    //  - Non-NULL — money arrived through the gateway for this unlock.
    //  - NULL with an attempt id — the synthetic row
    //    `ContactUnlockService.recordWalletUnlockPayment` writes for an unlock
    //    settled from wallet balance. No external money arrived AT THIS MOMENT,
    //    but it may have arrived earlier as a top-up.
    //
    // Top-ups and penalties match neither arm, so they still cannot trigger a
    // parrainage on their own.
    const qualifying = await this.prisma.paymentRequest.findFirst({
      where: {
        profile_id: refereeId,
        status: PaymentRequestStatus.APPROVED,
        deleted_at: null,
        OR: [
          { request_type: { in: QUALIFYING_PAYMENT_TYPES } },
          { contact_unlock_attempt_id: { not: null } },
        ],
      },
      orderBy: { created_at: 'asc' },
      select: { id: true, amount: true, request_type: true },
    });
    if (!qualifying) return NOT_QUALIFIED;

    const amount = Number(qualifying.amount ?? 0);

    /**
     * The base the payout may be divided from: real money, never credit the
     * platform issued itself.
     *
     * A gateway payment IS the real money, so it is its own base. A
     * wallet-funded unlock is capped by everything this person has ever topped
     * up, because `Wallet.balance` commingles top-ups with welcome credit and
     * cannot say which of the two funded this particular debit.
     *
     * Capping rather than tracking consumption is what keeps this cheap and
     * still safe. The farm it closes: top up 100, collect 500 of welcome
     * credit, unlock a 500 contact from the mixed balance. The unlock reads as
     * 500, but only 100 ever came in — so the base is 100, and the programme
     * can never issue more credit than that referee actually paid the platform.
     * An account with no top-up at all gets a base of zero and pays nothing.
     *
     * It is deliberately conservative when an unlock genuinely mixes the two:
     * paying less than was collected is the safe direction to be wrong.
     */
    const realMoneyBaseFcfa =
      qualifying.request_type === null
        ? Math.min(amount, await this.lifetimeTopUpFcfa(refereeId))
        : amount;

    const referrer = await this.prisma.profile.findUnique({
      where: { id: referral.referrer_id },
      select: { status: true, verification_status: true, deleted_at: true },
    });

    if (
      !referrer ||
      referrer.deleted_at !== null ||
      referrer.status === AccountStatus.BANNED
    ) {
      await this.close(
        referral.id,
        ReferralStatus.FORFEITED,
        qualifying.id,
        'Parrain supprimé ou banni au moment du paiement.',
      );
      return NOT_QUALIFIED;
    }

    const referrerEligible =
      referrer.status === AccountStatus.ACTIVE &&
      referrer.verification_status === VerificationStatus.VERIFIED;

    if (!referrerEligible) {
      const heldForMs = Date.now() - referral.created_at.getTime();
      if (heldForMs > HOLD_EXPIRY_DAYS * 24 * 60 * 60 * 1000) {
        await this.close(
          referral.id,
          ReferralStatus.FORFEITED,
          qualifying.id,
          `Parrain non vérifié plus de ${HOLD_EXPIRY_DAYS} jours après le parrainage.`,
        );
        return NOT_QUALIFIED;
      }
      await this.close(
        referral.id,
        ReferralStatus.QUALIFIED_ON_HOLD,
        qualifying.id,
        'Filleul a payé, parrain pas encore actif et vérifié. Se règlera à la validation du KYC.',
      );
      return NOT_QUALIFIED;
    }

    const credits = await this.systemConfig.getReferralCredits();

    if (credits.maxRewardedPerReferrer !== null) {
      const rewardedCount = await this.prisma.referral.count({
        where: {
          referrer_id: referral.referrer_id,
          status: ReferralStatus.REWARDED,
        },
      });
      if (rewardedCount >= credits.maxRewardedPerReferrer) {
        await this.close(
          referral.id,
          ReferralStatus.CAPPED,
          qualifying.id,
          `Parrain au plafond (${rewardedCount}/${credits.maxRewardedPerReferrer} parrainages rémunérés).`,
        );
        return NOT_QUALIFIED;
      }
    }

    return {
      qualifies: true,
      referralId: referral.id,
      referrerId: referral.referrer_id,
      qualifyingPaymentRequestId: qualifying.id,
      realMoneyBaseFcfa,
      credits,
    };
  }

  /**
   * Tell the parrain their credit landed.
   *
   * Email only, for now. A parrain who shared their code weeks ago is almost
   * certainly outside the WhatsApp 24-hour service window, where a free-form
   * message is rejected with 63016 and disappears without a trace. The approved
   * template that reaches them is Meta-gated and tracked separately; this ships
   * the news through the channel that already works.
   */
  private async notifyReferrer(
    referrerId: string,
    refereeId: string,
    amount: number,
  ): Promise<void> {
    try {
      const [referrer, referee] = await Promise.all([
        this.prisma.profile.findUnique({
          where: { id: referrerId },
          select: {
            first_name: true,
            email: true,
            profile_type: true,
            is_business: true,
          },
        }),
        this.prisma.profile.findUnique({
          where: { id: refereeId },
          select: { first_name: true },
        }),
      ]);
      if (!referrer?.email || !referee) return;

      // Each product's own: a business parrain lands in its dashboard.
      const audience = audienceOf(referrer);
      const appUrl = appUrlFor(audience);
      await this.mail.sendMail({
        to: referrer.email,
        subject: 'Votre parrainage vous a rapporté un crédit',
        html: await this.layout.wrap(
          referralRewardedEmail(referrer.first_name, {
            refereeName: referee.first_name,
            creditedAmount: amount,
            appUrl,
            audience,
          }),
          {
            previewText: REFERRAL_REWARDED_EMAIL_PREVIEW,
            product: productOf(audience),
          },
        ),
      });
    } catch (err) {
      this.logger.warn(
        `Referral reward email failed for referrer=${referrerId}`,
        err,
      );
    }
  }

  /**
   * Settle everything held on a parrain who has just become eligible.
   *
   * Called from the KYC approval path, beside the welcome credit grant. This is
   * why holding is cheaper than forfeiting: the retry trigger already exists,
   * so there is no sweep and no scheduler to own.
   */
  async settleHeldForReferrer(referrerId: string): Promise<void> {
    const held = await this.prisma.referral.findMany({
      where: {
        referrer_id: referrerId,
        status: ReferralStatus.QUALIFIED_ON_HOLD,
      },
      select: { referee_id: true },
    });

    for (const referral of held) {
      await this.settleForReferee(referral.referee_id).catch((err) =>
        this.logger.warn(
          `Held referral settlement failed for referee=${referral.referee_id}`,
          err,
        ),
      );
    }
  }

  // ── Read models ───────────────────────────────────────────────────────────

  /** The logged-in user's own parrainage screen. */
  async getOwnReferralSummary(profileId: string) {
    // Settle opportunistically: if a payout was missed because the process died
    // between the payment and the fire-and-forget hook, the person who lost the
    // money recovers it by opening this screen.
    await this.settleForReferee(profileId).catch((err) =>
      this.logger.warn(`Opportunistic settle failed for ${profileId}`, err),
    );

    const [code, credits, counts, earned] = await Promise.all([
      this.ensureReferralCode(profileId),
      this.systemConfig.getReferralCredits(),
      this.prisma.referral.groupBy({
        by: ['status'],
        where: { referrer_id: profileId, deleted_at: null },
        _count: { _all: true },
      }),
      this.prisma.referral.aggregate({
        where: { referrer_id: profileId, status: ReferralStatus.REWARDED },
        _sum: { referrer_amount: true },
      }),
    ]);

    const byStatus = new Map(counts.map((c) => [c.status, c._count._all]));
    const joined = counts.reduce((sum, c) => sum + c._count._all, 0);

    const isPercentage = credits.commissionType === 'PERCENTAGE';

    // Quoted through the settlement's own function, not alongside it: promising
    // a credit and then declining to pay it is the one outcome this feature
    // cannot afford.
    //
    // The base is chosen so the quote is base-independent in both modes. FIXED
    // amounts are absolute, so any base returns the configured pair. Percentage
    // shares OF 100 are the percentages themselves — clamped, and capped
    // against each other, exactly as a real settlement would clamp them.
    const payout = computeReferralPayout(
      isPercentage ? 100 : 0,
      referralPayoutSettingsFrom(
        // The per-referral ceiling is a franc amount. It genuinely bounds a
        // FIXED payout, so it belongs in that quote. It cannot be expressed as
        // a share without knowing the base, so the percentage quote drops it
        // rather than reporting a percentage that is not the configured one.
        isPercentage ? { ...credits, maxPayoutPerReferralFcfa: 0 } : credits,
      ),
    );

    return {
      code,
      /**
       * What unit the two numbers below are in. The client needs this to render
       * "300 FCFA" versus "60 %" — without it, a percentage configuration reads
       * on screen as a derisory franc amount.
       */
      commissionType: credits.commissionType,
      referrerCreditFcfa: payout.referrerAmount,
      refereeCreditFcfa: payout.refereeAmount,
      /**
       * What the filleul's first payment has to reach for the parrainage to pay
       * anything — the same number the settle floor uses, from the same
       * function.
       *
       * Null in PERCENTAGE mode, where there is no minimum: the payout is a
       * share of whatever was paid, so it fits inside any payment by
       * construction and no floor can fire. The existing client already guards
       * this field with `Number.isFinite`, so null degrades to the sentence
       * without a threshold rather than printing "undefined".
       */
      minQualifyingAmountFcfa: isPercentage ? null : payout.totalPayout,
      maxRewardedPerReferrer: credits.maxRewardedPerReferrer,
      joinedCount: joined,
      rewardedCount: byStatus.get(ReferralStatus.REWARDED) ?? 0,
      pendingCount: byStatus.get(ReferralStatus.PENDING) ?? 0,
      totalEarnedFcfa: Number(earned._sum.referrer_amount ?? 0),
    };
  }

  /** Admin list. `profileId` restricts to one profile in either role. */
  async listForAdmin(query: AdminListReferralsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ReferralWhereInput = {
      deleted_at: null,
      // Soft-deleted profiles keep their referral rows — onDelete: Cascade does
      // nothing for a deleted_at. Without this an admin browses parrainages
      // pointing at archived accounts.
      referrer: { deleted_at: null },
      referee: { deleted_at: null },
      ...(query.status?.length && {
        status: { in: query.status as ReferralStatus[] },
      }),
      ...(query.profileId && {
        OR: [{ referrer_id: query.profileId }, { referee_id: query.profileId }],
      }),
      ...((query.created_from || query.created_to) && {
        created_at: {
          ...(query.created_from && { gte: new Date(query.created_from) }),
          ...(query.created_to && { lte: new Date(query.created_to) }),
        },
      }),
    };

    if (query.q) {
      const q = query.q;
      const nameMatch: Prisma.ProfileWhereInput = {
        OR: [
          { first_name: { contains: q, mode: 'insensitive' } },
          { last_name: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q, mode: 'insensitive' } },
        ],
      };
      // AND, not a second OR: a `q` combined with a profileId filter has to
      // narrow both, and spreading another OR onto `where` would silently
      // replace the one profileId wrote.
      where.AND = [
        {
          OR: [
            { code_used: { contains: q, mode: 'insensitive' } },
            { referrer: nameMatch },
            { referee: nameMatch },
          ],
        },
      ];
    }

    const profileSelect = {
      select: {
        id: true,
        first_name: true,
        last_name: true,
        phone: true,
        profile_type: true,
      },
    } as const;

    const [rows, total] = await Promise.all([
      this.prisma.referral.findMany({
        where,
        select: {
          id: true,
          created_at: true,
          code_used: true,
          source: true,
          status: true,
          rewarded_at: true,
          referrer_amount: true,
          referee_amount: true,
          settlement_note: true,
          qualifying_payment_request_id: true,
          qualifying_payment: { select: { amount: true, request_type: true } },
          referrer: profileSelect,
          referee: profileSelect,
        },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.referral.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at.toISOString(),
        codeUsed: r.code_used,
        source: r.source,
        status: r.status,
        rewardedAt: r.rewarded_at?.toISOString() ?? null,
        referrerAmount:
          r.referrer_amount === null ? null : Number(r.referrer_amount),
        refereeAmount:
          r.referee_amount === null ? null : Number(r.referee_amount),
        settlementNote: r.settlement_note,
        qualifyingPaymentRequestId: r.qualifying_payment_request_id,
        qualifyingAmount:
          r.qualifying_payment?.amount == null
            ? null
            : Number(r.qualifying_payment.amount),
        qualifyingType: r.qualifying_payment?.request_type ?? null,
        referrer: toAdminParty(r.referrer),
        referee: toAdminParty(r.referee),
      })),
      total,
      page,
      limit,
    };
  }

  /** Header cards for the admin referrals page. */
  async getAdminStats() {
    const [byStatus, paid] = await Promise.all([
      this.prisma.referral.groupBy({
        by: ['status'],
        where: { deleted_at: null },
        _count: { _all: true },
      }),
      this.prisma.referral.aggregate({
        where: { status: ReferralStatus.REWARDED, deleted_at: null },
        _sum: { referrer_amount: true, referee_amount: true },
      }),
    ]);

    const byStatusMap = new Map(byStatus.map((s) => [s.status, s._count._all]));
    return {
      total: byStatus.reduce((sum, s) => sum + s._count._all, 0),
      pending: byStatusMap.get(ReferralStatus.PENDING) ?? 0,
      onHold: byStatusMap.get(ReferralStatus.QUALIFIED_ON_HOLD) ?? 0,
      rewarded: byStatusMap.get(ReferralStatus.REWARDED) ?? 0,
      capped: byStatusMap.get(ReferralStatus.CAPPED) ?? 0,
      forfeited: byStatusMap.get(ReferralStatus.FORFEITED) ?? 0,
      totalPaidOutFcfa:
        Number(paid._sum.referrer_amount ?? 0) +
        Number(paid._sum.referee_amount ?? 0),
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Everything this profile has ever moved into the platform as real money.
   *
   * `TOP_UP_CREDIT` is the marker, and it is written in exactly one place —
   * `PaymentRequestService.handleWalletTopUpPostPayment`, which only runs for a
   * gateway-confirmed `WALLET_TOP_UP`. Nothing else can produce that row type,
   * which is what makes it trustworthy as a measure of real money.
   *
   * Deliberately NOT the current balance. Balance falls as it is spent, so a
   * referee who topped up 2000 and unlocked a contact yesterday would look
   * poorer today than the money they actually brought in. And the other credit
   * types on the same wallet — WELCOME_CREDIT, MANUAL_CREDIT, REFERRAL_CREDIT —
   * are all platform-issued, which is exactly what must not count.
   */
  private async lifetimeTopUpFcfa(profileId: string): Promise<number> {
    const wallet = await this.prisma.wallet.findFirst({
      where: { owner_type: WalletOwnerType.PROFILE, profile_id: profileId },
      select: { id: true },
    });
    if (!wallet) return 0;

    const topUps = await this.prisma.walletTransaction.aggregate({
      where: {
        wallet_id: wallet.id,
        type: WalletTransactionType.TOP_UP_CREDIT,
        deleted_at: null,
      },
      _sum: { amount: true },
    });
    return Number(topUps._sum.amount ?? 0);
  }

  /**
   * Move a referral to a non-REWARDED outcome, recording why and which payment
   * exposed it. Guarded by the same conditional claim as the payout so a settle
   * racing a settle cannot overwrite a completed one.
   */
  private async close(
    referralId: string,
    status: ReferralStatus,
    qualifyingPaymentRequestId: string,
    note: string,
    amounts?: { referrerAmount: number; refereeAmount: number },
  ): Promise<void> {
    await this.prisma.referral.updateMany({
      where: {
        id: referralId,
        status: {
          in: [ReferralStatus.PENDING, ReferralStatus.QUALIFIED_ON_HOLD],
        },
      },
      data: {
        status,
        settlement_note: note,
        qualifying_payment_request_id: qualifyingPaymentRequestId,
        ...(amounts && {
          rewarded_at: new Date(),
          referrer_amount: amounts.referrerAmount,
          referee_amount: amounts.refereeAmount,
        }),
      },
    });
    await this.adminCache.invalidate('referrals');
  }
}
