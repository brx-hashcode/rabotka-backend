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
    const referral = await this.prisma.referral.findUnique({
      where: { referee_id: refereeId },
      select: {
        id: true,
        referrer_id: true,
        status: true,
        created_at: true,
      },
    });
    if (!referral) return;
    if (
      referral.status !== ReferralStatus.PENDING &&
      referral.status !== ReferralStatus.QUALIFIED_ON_HOLD
    ) {
      return;
    }

    const qualifying = await this.prisma.paymentRequest.findFirst({
      where: {
        profile_id: refereeId,
        status: PaymentRequestStatus.APPROVED,
        request_type: { in: QUALIFYING_PAYMENT_TYPES },
        deleted_at: null,
      },
      orderBy: { created_at: 'asc' },
      select: { id: true, amount: true },
    });
    if (!qualifying) return;

    const qualifyingAmount = Number(qualifying.amount ?? 0);

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
      return;
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
        return;
      }
      await this.close(
        referral.id,
        ReferralStatus.QUALIFIED_ON_HOLD,
        qualifying.id,
        'Filleul a payé, parrain pas encore actif et vérifié. Se règlera à la validation du KYC.',
      );
      return;
    }

    const { referrerCreditFcfa, refereeCreditFcfa, maxRewardedPerReferrer } =
      await this.systemConfig.getReferralCredits();

    const { referrerAmount, refereeAmount, totalPayout } = this.resolvePayout(
      referrerCreditFcfa,
      refereeCreditFcfa,
    );

    if (maxRewardedPerReferrer !== null) {
      const rewardedCount = await this.prisma.referral.count({
        where: {
          referrer_id: referral.referrer_id,
          status: ReferralStatus.REWARDED,
        },
      });
      if (rewardedCount >= maxRewardedPerReferrer) {
        await this.close(
          referral.id,
          ReferralStatus.CAPPED,
          qualifying.id,
          `Parrain au plafond (${rewardedCount}/${maxRewardedPerReferrer} parrainages rémunérés).`,
        );
        return;
      }
    }

    // The program must never pay out more than the payment that triggered it
    // brought in. Without this, the cheapest qualifying payment — a worker-side
    // contact unlock, 100 FCFA by default — buys strictly more credit than it
    // costs, and the cap only bounds how many times that can be repeated.
    // Recomputed from config on every settle, so changing a fee or a credit
    // keeps this honest without anyone remembering to update a floor.
    if (totalPayout > qualifyingAmount) {
      await this.close(
        referral.id,
        ReferralStatus.CAPPED,
        qualifying.id,
        `Paiement déclencheur (${qualifyingAmount} FCFA) inférieur au total des crédits (${totalPayout} FCFA).`,
      );
      return;
    }

    if (totalPayout === 0) {
      // Both credits configured to zero: the program is off. Close the row as
      // settled-for-nothing rather than leaving it PENDING, so switching the
      // amounts back on later does not silently back-pay every referral ever
      // recorded.
      await this.close(
        referral.id,
        ReferralStatus.REWARDED,
        qualifying.id,
        'Montants de parrainage à zéro au moment du règlement.',
        { referrerAmount: 0, refereeAmount: 0 },
      );
      return;
    }

    // Resolve both wallets before opening the transaction — upserting inside it
    // would hold the referral row lock across two more writes for no reason.
    const referrerWallet = await this.wallet.getOrCreateProfileWallet(
      referral.referrer_id,
    );
    const refereeWallet =
      await this.wallet.getOrCreateProfileWallet(refereeId);

    const credits = [
      {
        walletId: referrerWallet.id,
        amount: referrerAmount,
        referenceType: 'referral:referrer',
      },
      {
        walletId: refereeWallet.id,
        amount: refereeAmount,
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
          id: referral.id,
          status: {
            in: [ReferralStatus.PENDING, ReferralStatus.QUALIFIED_ON_HOLD],
          },
        },
        data: {
          status: ReferralStatus.REWARDED,
          rewarded_at: new Date(),
          referrer_amount: referrerAmount,
          referee_amount: refereeAmount,
          qualifying_payment_request_id: qualifying.id,
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
            reference_id: referral.id,
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
      `Referral ${referral.id} rewarded: ${referrerAmount} FCFA to referrer, ` +
        `${refereeAmount} FCFA to referee, triggered by payment ${qualifying.id}`,
    );

    // Fire-and-forget: the credit is already committed, and a mail failure must
    // not make a settled parrainage look unsettled to the caller.
    void this.notifyReferrer(referral.referrer_id, refereeId, referrerAmount);
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
          select: { first_name: true, email: true },
        }),
        this.prisma.profile.findUnique({
          where: { id: refereeId },
          select: { first_name: true },
        }),
      ]);
      if (!referrer?.email || !referee) return;

      const appUrl = this.config.get<string>('APP_URL') ?? '';
      await this.mail.sendMail({
        to: referrer.email,
        subject: 'Votre parrainage vous a rapporté un crédit',
        html: await this.layout.wrap(
          referralRewardedEmail(referrer.first_name, {
            refereeName: referee.first_name,
            creditedAmount: amount,
            appUrl,
          }),
          { previewText: REFERRAL_REWARDED_EMAIL_PREVIEW },
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

    const payout = this.resolvePayout(
      credits.referrerCreditFcfa,
      credits.refereeCreditFcfa,
    );

    return {
      code,
      referrerCreditFcfa: payout.referrerAmount,
      refereeCreditFcfa: payout.refereeAmount,
      /**
       * What the filleul's first payment has to reach for the parrainage to pay
       * anything — the same number the settle floor uses, from the same
       * function. The screen quotes it, so it must not be a second estimate of
       * it: promising a credit and then declining to pay it is the one outcome
       * this feature cannot afford.
       */
      minQualifyingAmountFcfa: payout.totalPayout,
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

  /**
   * Config values arrive as strings an admin typed. FCFA has no minor unit, so
   * round; a negative or unparseable amount means the config is broken, and the
   * right response in a fire-and-forget path is to pay nothing rather than
   * throw into a log nobody reads.
   */
  /**
   * The two credit amounts and their total, from raw config values.
   *
   * One place, because `totalPayout` is simultaneously what gets paid and the
   * minimum a triggering payment must reach to pay it — and the parrainage
   * screen quotes that minimum to the user. A second copy of this arithmetic is
   * a promise on screen that the settle logic can silently stop honouring.
   */
  private resolvePayout(
    referrerCreditFcfa: number,
    refereeCreditFcfa: number,
  ): { referrerAmount: number; refereeAmount: number; totalPayout: number } {
    const referrerAmount = this.sanitizeAmount(referrerCreditFcfa);
    const refereeAmount = this.sanitizeAmount(refereeCreditFcfa);
    return {
      referrerAmount,
      refereeAmount,
      totalPayout: referrerAmount + refereeAmount,
    };
  }

  private sanitizeAmount(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.round(value);
  }
}
