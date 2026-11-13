import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  BusinessBillingPeriod,
  type BusinessCredit,
  BusinessCreditKind,
  BusinessSubscriptionStatus,
  JobOfferStatus,
  PaymentRequestStatus,
  PaymentRequestType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  AdminNotificationEvent,
  type AdminNotificationPayload,
} from '../../../common/events/admin-notification.events';
import { SystemConfigService } from '../../system-config/system-config.service';
import { MailService } from '../../mail/mail.service';
import { LayoutService } from '../../mail/layout.service';
import { appUrlFor } from '../../mail/audience';
import {
  businessCreditsAddedEmail,
  businessSubscriptionActiveEmail,
  businessSubscriptionCancelledEmail,
  businessSubscriptionExpiredEmail,
  businessSubscriptionExpiringEmail,
  businessSubscriptionGrantedEmail,
  businessTrialStartedEmail,
} from '../../mail/templates';
import { notifyProfile } from '../../profile-notification/profile-notification.events';
import type { NotificationInput } from '../../profile-notification/notification-catalog';
import {
  counterWindow,
  dueReminder,
  isUpgrade,
  nextPeriodStart,
  periodEnd,
  remaining,
  upgradedEnd,
} from './subscription-rules';
import {
  BUSINESS_CREDIT_PACK_PAID_EVENT,
  BUSINESS_SUBSCRIPTION_PAID_EVENT,
  BUSINESS_VERIFIED_EVENT,
  type BusinessSubscriptionPaidPayload,
  type BusinessVerifiedPayload,
} from './subscription.events';
import { businessEmailRecipients } from '../team/business-recipients';
import {
  creditBalance,
  creditExpiry,
  creditLabel,
  giveBackCredits,
  PACK_SETTING,
  takeCredits,
} from './business-credits';

type Db = Prisma.TransactionClient | PrismaService;

/** A period counter a pack can top up, with its credit-funded share. */
type Counter = 'cv_screened' | 'offers_published' | 'offer_drafts_used';

const FROM_CREDITS: Record<Counter, string> = {
  cv_screened: 'cv_from_credits',
  offers_published: 'offers_from_credits',
  offer_drafts_used: 'offer_drafts_from_credits',
};

const CREDIT_KIND: Record<Counter, BusinessCreditKind> = {
  cv_screened: BusinessCreditKind.CV,
  offers_published: BusinessCreditKind.OFFER,
  offer_drafts_used: BusinessCreditKind.OFFER_DRAFT,
};

/** Thrown inside a charge's transaction to undo it: no room after all. */
class NoRoom extends Error {}

/** A limited quota's room this period, plus the packs' credits. */
function withCredits(
  quota: number | null,
  used: number,
  credits: number,
): number | null {
  return quota === null ? null : Math.max(0, quota - used) + credits;
}

/** How far back a paid subscription without its period is looked for. */
const RECONCILE_DAYS = 30;
/** Left to the payment event before the sweep steps in. */
const RECONCILE_GRACE_MS = 5 * 60 * 1000;
/** The hourly run that tells the admins: the first after the grace. */
const RECONCILE_ALERT_WINDOW_MS = 60 * 60 * 1000;

/** When a period's counters start again: next month of it, or its end. */
function countersEnd(sub: { starts_at: Date; ends_at: Date }): Date {
  return (
    counterWindow(sub.starts_at, sub.ends_at, new Date()).resetsAt ??
    sub.ends_at
  );
}

/** « 5 décembre 2026 », for the limit messages. */
function frenchDay(d: Date): string {
  return d.toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Brazzaville',
  });
}

const RUNNING: BusinessSubscriptionStatus[] = [
  BusinessSubscriptionStatus.TRIAL,
  BusinessSubscriptionStatus.ACTIVE,
];

const NO_PLAN_TO_PUBLISH =
  'Choisissez une formule depuis votre espace, rubrique « Abonnement », pour publier vos offres.';

const NO_PLAN_TO_MESSAGE =
  'Choisissez une formule depuis votre espace, rubrique « Abonnement », pour écrire aux candidats.';

const NO_PLAN_TO_INVITE =
  'Choisissez une formule depuis votre espace, rubrique « Abonnement », pour inviter des profils à postuler.';

function noOfferLeft(
  e: {
    plan: { name: string } | null;
    activeOffersLimit: number | null;
  },
  packSold = false,
): string {
  const n = e.activeOffersLimit ?? 0;
  return `Votre formule ${e.plan?.name ?? ''} permet de publier ${n} offre${n > 1 ? 's' : ''} par période, déjà publiée${n > 1 ? 's' : ''}. Passez à une formule supérieure${packSold ? ' ou achetez un pack d’offres' : ''} pour en publier davantage, ou attendez la prochaine période.`;
}

export const PERIOD_LABEL: Record<BusinessBillingPeriod, string> = {
  TRIAL: 'essai gratuit',
  MONTHLY: 'mensuel',
  ANNUAL: 'annuel',
};

/** What a business may do right now, from its current period's plan. */
export type BusinessEntitlements = {
  plan: { id: string; code: string; name: string } | null;
  status: BusinessSubscriptionStatus | null;
  endsAt: string | null;
  /**
   * When the counters start again (a new month of a longer period); null
   * when they only do with the next period, at `endsAt`.
   */
  countersResetAt: string | null;
  /** Contact unlocks still covered this period; null: unlimited; 0: pay per unlock. */
  unlocksRemaining: number | null;
  unlocksQuota: number | null;
  unlocksUsed: number;
  /** Offers active at once; null: unlimited; 0: none (no plan). */
  /** Offers the plan lets the business publish per period. Null: unlimited. */
  activeOffersLimit: number | null;
  /** Offers online right now (information only: the limit is per period). */
  activeOffers: number;
  /** Has published at least once, whatever became of the offer since. */
  hasPublishedOffer: boolean;
  /** Offers published during the current period. */
  offersPublished: number;
  /** Offers that may still be published this period. Null: unlimited. */
  offersRemaining: number | null;
  /** CVs the AI screening may still read this period; null: unlimited; 0: none. */
  cvRemaining: number | null;
  cvQuota: number | null;
  cvUsed: number;
  cvBatchMax: number;
  cvFileMaxMb: number;
  cvRetentionDays: number;
  /** Questions about one analysed CV (its chat); 0: no chat. */
  cvChatQuestions: number;
  /** Offers the AI may still write this period. Null: unlimited; 0: none. */
  offerDraftsRemaining: number | null;
  offerDraftsQuota: number | null;
  includesPreselection: boolean;
  priorityVisibility: boolean;
  /** « Publier sur LinkedIn » from Rabotka (the share link is open to all). */
  linkedinPosting: boolean;
  /** « Exports RH »: candidates, staff register, ACPE declaration. */
  hrExports: boolean;
  /** Recruteurs the business may have (the holder is its one administrator). Null: unlimited; 0: none. */
  recruitersLimit: number | null;
  /** Évaluateurs the business may have. Null: unlimited; 0: none. */
  reviewersLimit: number | null;
  /** Recruteurs invited or active now. */
  recruiters: number;
  /** Évaluateurs invited or active now. */
  reviewers: number;
  /** AI features the plan has but the trial leaves out (their quotas read 0). */
  trialLocked: TrialAiFeature[];
  /**
   * Units bought in packs and not used nor expired. Spent after the plan's
   * own quota, and only with a plan running; the `*Remaining` above count
   * them already.
   */
  credits: {
    cv: number;
    offers: number;
    contacts: number;
    offerDrafts: number;
  };
};

/** The AI features a trial may leave out (SystemConfig `business.trial_*`). */
export type TrialAiFeature = 'cvAnalysis' | 'cvChat' | 'offerWriter';

/** Why an AI feature is refused during the trial: it comes with a paid plan. */
export const TRIAL_AI_REFUSAL =
  'Disponible avec une formule payante, après votre essai gratuit. Choisissez une formule depuis votre espace, rubrique « Abonnement ».';

/**
 * Whether a business may have this plan: every catalog plan, and a custom
 * plan only for the business it was made for.
 */
export function planAvailableTo(
  plan: { business_id: string | null },
  businessId: string,
): boolean {
  return !plan.business_id || plan.business_id === businessId;
}

/**
 * How many CVs one analysis may read now: the plan's batch, but never more
 * than the « CV inclus » left. The charge is all or nothing, so a batch above
 * what is left read nothing at all, and the sweep asked again every time.
 */
export function cvBatchRoom(
  e: Pick<BusinessEntitlements, 'cvBatchMax' | 'cvRemaining'>,
): number {
  return Math.max(0, Math.min(e.cvBatchMax, e.cvRemaining ?? e.cvBatchMax));
}

/**
 * Business plans: the trial, purchases and renewals, the quotas they carry,
 * and their expiry. Prices and quotas are the business_plans table (admin);
 * the trial and reminders are SystemConfig. Messages go by email and in-app,
 * never WhatsApp.
 */
@Injectable()
export class BusinessSubscriptionService {
  private readonly logger = new Logger(BusinessSubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly events: EventEmitter2,
  ) {}

  // ── Reading ──────────────────────────────────────────────────────────

  /**
   * The period covering now (trial or paid), with its plan — its counters
   * started again first when a new month of it has begun (an annual plan
   * gives its quotas « par mois »). Lazy: whoever reads or charges the period
   * first in a month resets it, once (conditional on the month it was in).
   */
  async current(businessId: string, db: Db = this.prisma, now = new Date()) {
    const where = {
      business_id: businessId,
      status: { in: RUNNING },
      starts_at: { lte: now },
      ends_at: { gt: now },
    };
    const sub = await db.businessSubscription.findFirst({
      where,
      include: { plan: true },
      orderBy: { starts_at: 'desc' },
    });
    if (!sub) return sub;
    const { from } = counterWindow(sub.starts_at, sub.ends_at, now);
    if (from <= (sub.counters_from ?? sub.starts_at)) return sub;
    await db.businessSubscription.updateMany({
      where: { id: sub.id, counters_from: sub.counters_from },
      data: {
        counters_from: from,
        unlocks_used: 0,
        cv_screened: 0,
        offer_drafts_used: 0,
        offers_published: 0,
        cv_from_credits: 0,
        offers_from_credits: 0,
        offer_drafts_from_credits: 0,
      },
    });
    // Reset by this call or a concurrent one: read what is there now.
    return db.businessSubscription.findFirst({
      where: { id: sub.id },
      include: { plan: true },
    });
  }

  /** The business behind a profile, or null when it is not a business. */
  async businessOf(profileId: string, db: Db = this.prisma) {
    const profile = await db.profile.findUnique({
      where: { id: profileId },
      select: { is_business: true, business: { select: { id: true } } },
    });
    return profile?.is_business && profile.business
      ? profile.business.id
      : null;
  }

  async entitlements(businessId: string): Promise<BusinessEntitlements> {
    const [sub, business] = await Promise.all([
      this.current(businessId),
      this.prisma.business.findUnique({
        where: { id: businessId },
        select: { profile_id: true },
      }),
    ]);
    const activeOffers = business
      ? await this.prisma.jobOffer.count({
          where: {
            employer_id: business.profile_id,
            status: {
              in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
            },
            deleted_at: null,
          },
        })
      : 0;
    const hasPublishedOffer = business
      ? (await this.prisma.jobOffer.count({
          where: { employer_id: business.profile_id },
          take: 1,
        })) > 0
      : false;
    // The people in the team now, invited or active: a plan's places are a
    // team size, freed when someone leaves.
    const { recruiters, reviewers } = await this.seatsInUse(businessId);
    const balance = await creditBalance(this.prisma, businessId);
    const credits = {
      cv: balance.CV,
      offers: balance.OFFER,
      contacts: balance.CONTACT,
      offerDrafts: balance.OFFER_DRAFT,
    };
    if (!sub) {
      return {
        plan: null,
        status: null,
        endsAt: null,
        countersResetAt: null,
        unlocksRemaining: 0,
        unlocksQuota: 0,
        unlocksUsed: 0,
        activeOffersLimit: 0,
        activeOffers,
        hasPublishedOffer,
        offersPublished: 0,
        offersRemaining: 0,
        cvRemaining: 0,
        cvQuota: 0,
        cvUsed: 0,
        cvBatchMax: 0,
        cvFileMaxMb: 0,
        cvRetentionDays: 0,
        cvChatQuestions: 0,
        offerDraftsRemaining: 0,
        offerDraftsQuota: 0,
        includesPreselection: false,
        priorityVisibility: false,
        linkedinPosting: false,
        hrExports: false,
        recruitersLimit: 0,
        reviewersLimit: 0,
        recruiters,
        reviewers,
        trialLocked: [],
        credits,
      };
    }
    // A trial leaves out the AI features not switched on for it: their quotas
    // read 0, so every gate (and the dashboard) treats them as not included.
    const locked = await this.trialLocks(sub);
    const cvLocked = locked.has('cvAnalysis');
    const draftsLocked = locked.has('offerWriter');
    return {
      plan: { id: sub.plan.id, code: sub.plan.code, name: sub.plan.name },
      status: sub.status,
      endsAt: sub.ends_at.toISOString(),
      countersResetAt:
        counterWindow(
          sub.starts_at,
          sub.ends_at,
          new Date(),
        ).resetsAt?.toISOString() ?? null,
      unlocksRemaining: withCredits(
        sub.plan.unlocks_per_period,
        sub.unlocks_used,
        credits.contacts,
      ),
      unlocksQuota: sub.plan.unlocks_per_period,
      unlocksUsed: sub.unlocks_used,
      activeOffersLimit: sub.plan.active_offers_limit,
      activeOffers,
      hasPublishedOffer,
      offersPublished: sub.offers_published,
      offersRemaining: withCredits(
        sub.plan.active_offers_limit,
        sub.offers_published,
        credits.offers,
      ),
      cvRemaining: cvLocked
        ? 0
        : withCredits(
            sub.plan.cv_screenings_per_period,
            sub.cv_screened,
            credits.cv,
          ),
      cvQuota: cvLocked ? 0 : sub.plan.cv_screenings_per_period,
      cvUsed: sub.cv_screened,
      cvBatchMax: sub.plan.cv_batch_max,
      cvFileMaxMb: sub.plan.cv_file_max_mb,
      cvRetentionDays: sub.plan.cv_retention_days,
      cvChatQuestions: locked.has('cvChat') ? 0 : sub.plan.cv_chat_questions,
      offerDraftsRemaining: draftsLocked
        ? 0
        : withCredits(
            sub.plan.offer_drafts_per_period,
            sub.offer_drafts_used,
            credits.offerDrafts,
          ),
      offerDraftsQuota: draftsLocked ? 0 : sub.plan.offer_drafts_per_period,
      includesPreselection: sub.plan.includes_preselection,
      priorityVisibility: sub.plan.priority_visibility,
      linkedinPosting: sub.plan.linkedin_posting,
      hrExports: sub.plan.hr_exports,
      recruitersLimit: sub.plan.recruiters_limit,
      reviewersLimit: sub.plan.reviewers_limit,
      recruiters,
      reviewers,
      trialLocked: [...locked],
      credits,
    };
  }

  /**
   * The AI features this period's plan includes but its trial leaves out
   * (none for a paid period). Read by entitlements() and by the consume
   * methods, which charge the plan directly.
   */
  private async trialLocks(sub: {
    billing_period: BusinessBillingPeriod;
    plan: {
      cv_screenings_per_period: number | null;
      cv_chat_questions: number;
      offer_drafts_per_period: number | null;
    };
  }): Promise<Set<TrialAiFeature>> {
    const locked = new Set<TrialAiFeature>();
    if (sub.billing_period !== BusinessBillingPeriod.TRIAL) return locked;
    const { trialAi } =
      await this.systemConfig.getBusinessSubscriptionSettings();
    const plan = sub.plan;
    if (!trialAi.cvAnalysis && plan.cv_screenings_per_period !== 0) {
      locked.add('cvAnalysis');
    }
    if (!trialAi.cvChat && plan.cv_chat_questions !== 0) {
      locked.add('cvChat');
    }
    if (!trialAi.offerWriter && plan.offer_drafts_per_period !== 0) {
      locked.add('offerWriter');
    }
    return locked;
  }

  /** The business dashboard's « Abonnement » page, in one read. */
  async overview(businessId: string) {
    const [entitlements, periods, plans] = await Promise.all([
      this.entitlements(businessId),
      this.prisma.businessSubscription.findMany({
        where: { business_id: businessId },
        include: { plan: { select: { name: true, code: true } } },
        orderBy: { starts_at: 'desc' },
        take: 24,
      }),
      this.plansFor(businessId),
    ]);
    const now = new Date();
    return {
      entitlements,
      // Soonest first: `periods` is newest first (the history's order), and
      // the first upcoming one is the only one startQueuedNow() will start.
      upcoming: periods
        .filter((p) => RUNNING.includes(p.status) && p.starts_at > now)
        .sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime())
        .map(toPeriodView),
      history: periods.map(toPeriodView),
      plans,
      trialUsed: periods.some((p) => p.billing_period === 'TRIAL'),
    };
  }

  /** Every plan, custom ones included, with the business each is made for (admin). */
  listPlans(activeOnly: boolean) {
    return this.prisma.businessPlan.findMany({
      where: { deleted_at: null, ...(activeOnly && { is_active: true }) },
      include: {
        business: { select: { id: true, name: true, profile_id: true } },
      },
      orderBy: [{ sort_order: 'asc' }, { monthly_price_fcfa: 'asc' }],
    });
  }

  /** What a business may choose: the catalog, and its own custom plans. */
  plansFor(businessId: string) {
    return this.prisma.businessPlan.findMany({
      where: {
        deleted_at: null,
        is_active: true,
        OR: [{ business_id: null }, { business_id: businessId }],
      },
      orderBy: [{ sort_order: 'asc' }, { monthly_price_fcfa: 'asc' }],
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Approval starts the trial, unless the admin chose not to (once per
   * business, ever; none if configured off).
   */
  @OnEvent(BUSINESS_VERIFIED_EVENT, { async: true })
  async onBusinessVerified(payload: BusinessVerifiedPayload): Promise<void> {
    if (payload.startTrial === false) return;
    try {
      await this.startTrial(payload.businessId);
    } catch (err) {
      this.logger.warn(
        `Trial start failed for business ${payload.businessId}`,
        err,
      );
    }
  }

  async startTrial(businessId: string, now = new Date()) {
    const settings = await this.systemConfig.getBusinessSubscriptionSettings();
    if (settings.trialDays <= 0 || !settings.trialPlanCode) return null;
    const plan = await this.prisma.businessPlan.findUnique({
      where: { code: settings.trialPlanCode },
    });
    // A custom plan is one business's: never the trial of every other.
    if (!plan || !plan.is_active || plan.deleted_at || plan.business_id) {
      this.logger.warn(
        `Trial plan « ${settings.trialPlanCode} » missing, inactive or custom`,
      );
      return null;
    }
    const already = await this.prisma.businessSubscription.findFirst({
      where: { business_id: businessId },
      select: { id: true },
    });
    if (already) return null;

    let sub;
    try {
      sub = await this.prisma.businessSubscription.create({
        data: {
          business_id: businessId,
          plan_id: plan.id,
          status: BusinessSubscriptionStatus.TRIAL,
          billing_period: BusinessBillingPeriod.TRIAL,
          starts_at: now,
          ends_at: periodEnd(
            now,
            BusinessBillingPeriod.TRIAL,
            settings.trialDays,
          ),
        },
      });
    } catch (err) {
      // The one-trial index: a concurrent approval already started it.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return null;
      }
      throw err;
    }
    await this.syncPriority(businessId);
    await this.tell(
      businessId,
      {
        type: 'BUSINESS_TRIAL_STARTED',
        planName: plan.name,
        endsAt: sub.ends_at.toISOString(),
      },
      'Votre essai gratuit Rabotka Business commence',
      (name, businessName) =>
        businessTrialStartedEmail(name, {
          businessName,
          planName: plan.name,
          endsAt: sub.ends_at,
          url: this.subscriptionUrl(),
        }),
    );
    return sub;
  }

  /** A paid BUSINESS_SUBSCRIPTION request: create its period (idempotent). */
  @OnEvent(BUSINESS_SUBSCRIPTION_PAID_EVENT, { async: true })
  async onPaid(payload: BusinessSubscriptionPaidPayload): Promise<void> {
    try {
      await this.activateFromPayment(payload.paymentRequestId);
    } catch (err) {
      this.logger.error(
        `Subscription activation failed for payment request ${payload.paymentRequestId}`,
        err,
      );
    }
  }

  async activateFromPayment(paymentRequestId: string, now = new Date()) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { id: paymentRequestId },
      select: {
        id: true,
        profile_id: true,
        status: true,
        request_type: true,
        business_plan_id: true,
        business_billing_period: true,
      },
    });
    if (
      !request ||
      request.request_type !== PaymentRequestType.BUSINESS_SUBSCRIPTION ||
      request.status !== PaymentRequestStatus.APPROVED ||
      !request.business_plan_id ||
      !request.business_billing_period
    ) {
      this.logger.warn(
        `Payment request ${paymentRequestId} is not a paid subscription`,
      );
      return null;
    }
    const businessId = await this.businessOf(request.profile_id);
    if (!businessId) {
      this.logger.warn(
        `Payment request ${paymentRequestId}: payer is not a business`,
      );
      return null;
    }
    const existing = await this.prisma.businessSubscription.findUnique({
      where: { payment_request_id: request.id },
    });
    if (existing) return existing;

    const created = await this.createPeriod(
      businessId,
      request.business_plan_id,
      request.business_billing_period,
      { paymentRequestId: request.id },
      now,
    );
    if (!created) return null;
    await this.tell(
      businessId,
      {
        type: 'BUSINESS_SUBSCRIPTION_ACTIVE',
        planName: created.plan.name,
        endsAt: created.ends_at.toISOString(),
      },
      `Votre abonnement ${created.plan.name} est confirmé`,
      (name) =>
        businessSubscriptionActiveEmail(name, {
          planName: created.plan.name,
          periodLabel: PERIOD_LABEL[created.billing_period],
          startsAt: created.starts_at,
          endsAt: created.ends_at,
          url: this.subscriptionUrl(),
        }),
    );
    return created;
  }

  /** A paid BUSINESS_CREDIT_PACK request: add its credits (idempotent). */
  @OnEvent(BUSINESS_CREDIT_PACK_PAID_EVENT, { async: true })
  async onCreditPackPaid(
    payload: BusinessSubscriptionPaidPayload,
  ): Promise<void> {
    try {
      await this.addCreditsFromPayment(payload.paymentRequestId);
    } catch (err) {
      this.logger.error(
        `Credit pack failed for payment request ${payload.paymentRequestId}`,
        err,
      );
    }
  }

  /**
   * Adds a paid pack's credits, kept 12 months. Once per payment request:
   * the event, the sweep and a retry may all ask.
   */
  async addCreditsFromPayment(paymentRequestId: string, now = new Date()) {
    const request = await this.prisma.paymentRequest.findUnique({
      where: { id: paymentRequestId },
      select: {
        id: true,
        profile_id: true,
        status: true,
        request_type: true,
        business_credit_kind: true,
        business_credit_quantity: true,
      },
    });
    if (
      !request ||
      request.request_type !== PaymentRequestType.BUSINESS_CREDIT_PACK ||
      request.status !== PaymentRequestStatus.APPROVED ||
      !request.business_credit_kind ||
      !request.business_credit_quantity
    ) {
      this.logger.warn(
        `Payment request ${paymentRequestId} is not a paid pack`,
      );
      return null;
    }
    const businessId = await this.businessOf(request.profile_id);
    if (!businessId) {
      this.logger.warn(
        `Payment request ${paymentRequestId}: payer is not a business`,
      );
      return null;
    }
    const existing = await this.prisma.businessCredit.findUnique({
      where: { payment_request_id: request.id },
    });
    if (existing) return existing;
    let credit: BusinessCredit;
    try {
      credit = await this.prisma.businessCredit.create({
        data: {
          business_id: businessId,
          kind: request.business_credit_kind,
          quantity: request.business_credit_quantity,
          expires_at: creditExpiry(now),
          payment_request_id: request.id,
        },
      });
    } catch (err) {
      // Added meanwhile by a concurrent call: that one tells the business.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this.prisma.businessCredit.findUnique({
          where: { payment_request_id: request.id },
        });
      }
      throw err;
    }
    const what = creditLabel(credit.kind, credit.quantity);
    await this.tell(
      businessId,
      {
        type: 'BUSINESS_CREDITS_ADDED',
        what,
        expiresAt: credit.expires_at.toISOString(),
      },
      `Pack ajouté : ${what}`,
      (name) =>
        businessCreditsAddedEmail(name, {
          what,
          expiresAt: credit.expires_at,
          url: this.subscriptionUrl(),
        }),
    );
    return credit;
  }

  /**
   * The « Packs » of the subscription page: the packs on sale (a price of 0
   * is not sold) and the credits bought, not expired, each with what is left.
   */
  async packs(businessId: string, now = new Date()) {
    const [settings, credits] = await Promise.all([
      this.systemConfig.getBusinessPackSettings(),
      this.prisma.businessCredit.findMany({
        where: { business_id: businessId, expires_at: { gt: now } },
        orderBy: { expires_at: 'asc' },
      }),
    ]);
    const kinds = Object.keys(PACK_SETTING) as BusinessCreditKind[];
    return {
      onSale: kinds
        .map((kind) => ({ kind, ...settings[PACK_SETTING[kind]] }))
        .filter((p) => p.priceFcfa > 0 && p.quantity > 0),
      credits: credits
        .filter((c) => c.used < c.quantity)
        .map((c) => ({
          id: c.id,
          kind: c.kind,
          quantity: c.quantity,
          left: c.quantity - c.used,
          boughtAt: c.created_at.toISOString(),
          expiresAt: c.expires_at.toISOString(),
        })),
    };
  }

  /**
   * An admin assigns a plan by hand. By default it is stacked like a
   * purchase; with `startNow` it replaces the running period today.
   */
  async grantByAdmin(
    businessId: string,
    planId: string,
    period: BusinessBillingPeriod,
    adminUserId: string | null,
    { startNow = false }: { startNow?: boolean } = {},
  ) {
    if (period === BusinessBillingPeriod.TRIAL) {
      throw new BadRequestException(
        'Choisissez une période mensuelle ou annuelle.',
      );
    }
    const created = await this.createPeriod(businessId, planId, period, {
      grantedBy: adminUserId,
      replaceRunning: startNow,
    });
    if (!created) throw new NotFoundException('Formule introuvable.');
    await this.tell(
      businessId,
      {
        type: 'BUSINESS_SUBSCRIPTION_GRANTED',
        subscriptionId: created.id,
        planName: created.plan.name,
        startsAt: created.starts_at.toISOString(),
        endsAt: created.ends_at.toISOString(),
      },
      `La formule ${created.plan.name} vous a été attribuée`,
      (name) =>
        businessSubscriptionGrantedEmail(name, {
          planName: created.plan.name,
          periodLabel: PERIOD_LABEL[created.billing_period],
          startsAt: created.starts_at,
          endsAt: created.ends_at,
          url: this.subscriptionUrl(),
        }),
    );
    return created;
  }

  /**
   * Ends a period now (or drops one not yet started), and the periods queued
   * after it. The business is told, with the admin's reason when given.
   */
  async cancelByAdmin(
    businessId: string,
    subscriptionId: string,
    adminUserId: string | null,
    reason: string | null = null,
  ) {
    const sub = await this.endWithQueue(
      businessId,
      subscriptionId,
      adminUserId,
    );
    await this.tell(
      businessId,
      {
        type: 'BUSINESS_SUBSCRIPTION_CANCELLED',
        planName: sub.plan.name,
        reason,
      },
      `Votre abonnement ${sub.plan.name} a été arrêté`,
      (name) =>
        businessSubscriptionCancelledEmail(name, {
          planName: sub.plan.name,
          reason,
          url: this.subscriptionUrl(),
        }),
    );
  }

  /** `cancelByAdmin` without the message: a plan deletion sends its own. */
  private async endWithQueue(
    businessId: string,
    subscriptionId: string,
    adminUserId: string | null,
  ) {
    const sub = await this.prisma.businessSubscription.findFirst({
      where: {
        id: subscriptionId,
        business_id: businessId,
        status: { in: RUNNING },
      },
      include: { plan: true },
    });
    if (!sub)
      throw new NotFoundException('Période introuvable ou déjà terminée.');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.businessSubscription.update({
        where: { id: sub.id },
        data: {
          status: BusinessSubscriptionStatus.CANCELLED,
          granted_by: adminUserId,
          // A started period ends now; one not yet started keeps its dates.
          ...(sub.starts_at < now ? { ends_at: now } : {}),
          expired_notified_at: now,
        },
      }),
      // The queue after it goes too: left alone, it would start later than
      // the period it followed, leaving the business without a plan until
      // then — and a new purchase would be placed behind it.
      this.prisma.businessSubscription.updateMany({
        where: {
          business_id: businessId,
          status: { in: RUNNING },
          starts_at: { gt: sub.starts_at },
          id: { not: sub.id },
        },
        data: {
          status: BusinessSubscriptionStatus.CANCELLED,
          granted_by: adminUserId,
          expired_notified_at: now,
        },
      }),
    ]);
    await this.syncPriority(businessId);
    return sub;
  }

  /**
   * The business starts its next, already paid period today instead of
   * waiting for the running one to end — typically when what the running
   * one includes is used up. The running period ends now and what it had
   * left is lost; the next one runs its full length from now, with fresh
   * counters, and anything queued behind it moves up by the same amount.
   * Only the very next period can be started.
   */
  async startQueuedNow(
    businessId: string,
    subscriptionId: string,
    now = new Date(),
  ) {
    const started = await this.prisma.$transaction(async (tx) => {
      const queued = await tx.businessSubscription.findMany({
        where: {
          business_id: businessId,
          status: BusinessSubscriptionStatus.ACTIVE,
          starts_at: { gt: now },
        },
        orderBy: { starts_at: 'asc' },
        include: { plan: true },
      });
      const next = queued[0];
      if (!next || next.id !== subscriptionId) {
        throw new NotFoundException(
          queued.some((q) => q.id === subscriptionId)
            ? 'Commencez d’abord la formule qui suit directement la vôtre.'
            : 'Aucune formule à venir à démarrer.',
        );
      }

      await tx.businessSubscription.updateMany({
        where: {
          business_id: businessId,
          status: { in: RUNNING },
          starts_at: { lte: now },
          ends_at: { gt: now },
        },
        data: {
          status: BusinessSubscriptionStatus.EXPIRED,
          ends_at: now,
          expired_notified_at: now,
        },
      });

      const ends = periodEnd(now, next.billing_period);
      const shift = ends.getTime() - next.ends_at.getTime();
      for (const later of queued.slice(1)) {
        await tx.businessSubscription.update({
          where: { id: later.id },
          data: {
            starts_at: new Date(later.starts_at.getTime() + shift),
            ends_at: new Date(later.ends_at.getTime() + shift),
          },
        });
      }
      return tx.businessSubscription.update({
        where: { id: next.id },
        data: { starts_at: now, ends_at: ends },
        include: { plan: true },
      });
    });
    await this.syncPriority(businessId);
    return toPeriodView(started);
  }

  /** Businesses with a period running or queued on each plan. */
  async businessesPerPlan(): Promise<Map<string, number>> {
    const rows = await this.prisma.businessSubscription.findMany({
      where: { status: { in: RUNNING } },
      distinct: ['plan_id', 'business_id'],
      select: { plan_id: true },
    });
    const counts = new Map<string, number>();
    for (const r of rows)
      counts.set(r.plan_id, (counts.get(r.plan_id) ?? 0) + 1);
    return counts;
  }

  /**
   * An admin deletes a plan. Past periods and payments point to it, so it
   * stays, hidden everywhere; every business on it loses it now: its period
   * on the plan (running or queued) is cancelled with what was queued after,
   * as an admin cancel does, and a business left without a plan is told.
   * The trial plan can't go while the trial setting names it.
   */
  async deletePlan(planId: string, adminUserId: string | null) {
    const plan = await this.prisma.businessPlan.findFirst({
      where: { id: planId, deleted_at: null },
    });
    if (!plan) throw new NotFoundException('Formule introuvable.');
    const settings = await this.systemConfig.getBusinessSubscriptionSettings();
    if (settings.trialPlanCode === plan.code) {
      throw new ConflictException(
        "Cette formule sert à l'essai gratuit : choisissez une autre formule d'essai dans les réglages avant de la supprimer.",
      );
    }
    await this.prisma.businessPlan.update({
      where: { id: plan.id },
      data: { deleted_at: new Date(), is_active: false },
    });

    // The earliest period on the plan per business: cancelling it takes the
    // later ones (on this plan or another) with it.
    const periods = await this.prisma.businessSubscription.findMany({
      where: { plan_id: plan.id, status: { in: RUNNING } },
      orderBy: { starts_at: 'asc' },
      select: { id: true, business_id: true },
    });
    const first = new Map<string, string>();
    for (const p of periods) {
      if (!first.has(p.business_id)) first.set(p.business_id, p.id);
    }
    for (const [businessId, subscriptionId] of first) {
      await this.endWithQueue(businessId, subscriptionId, adminUserId);
      if (await this.current(businessId)) continue;
      await this.tell(
        businessId,
        {
          type: 'BUSINESS_SUBSCRIPTION_EXPIRED',
          planName: plan.name,
          trial: false,
        },
        'Votre abonnement Rabotka Business est terminé',
        (name) =>
          businessSubscriptionExpiredEmail(name, {
            planName: plan.name,
            trial: false,
            withdrawn: true,
            url: this.subscriptionUrl(),
          }),
      );
    }
    return { plan, businesses: first.size };
  }

  /**
   * One period, after whatever is already running or queued. A paid plan
   * replaces a running trial at once rather than waiting for it to end, and
   * a dearer plan replaces the running paid one at once: its unused time
   * becomes extra days on the new plan, and what was queued follows it.
   */
  private async createPeriod(
    businessId: string,
    planId: string,
    period: BusinessBillingPeriod,
    by: {
      paymentRequestId?: string;
      grantedBy?: string | null;
      /** An admin's « start now »: the running period ends today. */
      replaceRunning?: boolean;
    },
    now = new Date(),
  ) {
    const plan = await this.prisma.businessPlan.findUnique({
      where: { id: planId },
    });
    // A deleted plan is never granted again; a payment taken for it before
    // the deletion is still honoured.
    if (!plan || (plan.deleted_at && !by.paymentRequestId)) return null;
    if (!planAvailableTo(plan, businessId)) {
      throw new BadRequestException('Cette formule n’est pas disponible.');
    }
    const created = await this.prisma.$transaction(async (tx) => {
      // One business's periods are placed one at a time: two payments
      // approved together both read the same latest end and overlapped, and
      // one paid period was never used.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId}))`;
      const trial = await tx.businessSubscription.findFirst({
        where: {
          business_id: businessId,
          status: BusinessSubscriptionStatus.TRIAL,
          ends_at: { gt: now },
        },
      });
      if (trial) {
        await tx.businessSubscription.update({
          where: { id: trial.id },
          data: {
            status: BusinessSubscriptionStatus.CANCELLED,
            ends_at: trial.starts_at < now ? now : trial.ends_at,
            expired_notified_at: now,
          },
        });
      }
      const running = await tx.businessSubscription.findFirst({
        where: {
          business_id: businessId,
          status: BusinessSubscriptionStatus.ACTIVE,
          starts_at: { lte: now },
          ends_at: { gt: now },
        },
        include: { plan: true },
        orderBy: { starts_at: 'desc' },
      });
      const upgrade = !!running && isUpgrade(running.plan, plan);
      if (running && (upgrade || by.replaceRunning)) {
        // An upgrade carries the unused days over; an admin replacing the
        // period with a plan no dearer starts it fresh, and the rest is lost.
        const ends = upgrade
          ? upgradedEnd(now, running, { plan, period })
          : periodEnd(now, period);
        await tx.businessSubscription.update({
          where: { id: running.id },
          data: upgrade
            ? {
                status: BusinessSubscriptionStatus.EXPIRED,
                ends_at: now,
                expired_notified_at: now,
              }
            : {
                // Shown as cut short by the admin in the history.
                status: BusinessSubscriptionStatus.CANCELLED,
                granted_by: by.grantedBy ?? null,
                ends_at: now,
                expired_notified_at: now,
              },
        });
        // What was queued after the old period now follows the new one.
        const shift = ends.getTime() - running.ends_at.getTime();
        const queued = await tx.businessSubscription.findMany({
          where: {
            business_id: businessId,
            status: BusinessSubscriptionStatus.ACTIVE,
            starts_at: { gte: running.ends_at },
          },
          select: { id: true, starts_at: true, ends_at: true },
        });
        for (const q of queued) {
          await tx.businessSubscription.update({
            where: { id: q.id },
            data: {
              starts_at: new Date(q.starts_at.getTime() + shift),
              ends_at: new Date(q.ends_at.getTime() + shift),
            },
          });
        }
        return tx.businessSubscription.create({
          data: {
            business_id: businessId,
            plan_id: plan.id,
            status: BusinessSubscriptionStatus.ACTIVE,
            billing_period: period,
            starts_at: now,
            ends_at: ends,
            payment_request_id: by.paymentRequestId ?? null,
            granted_by: by.grantedBy ?? null,
          },
          include: { plan: true },
        });
      }
      const latest = await tx.businessSubscription.findFirst({
        where: {
          business_id: businessId,
          status: BusinessSubscriptionStatus.ACTIVE,
          ends_at: { gt: now },
        },
        orderBy: { ends_at: 'desc' },
        select: { ends_at: true },
      });
      const starts = nextPeriodStart(now, latest?.ends_at ?? null);
      return tx.businessSubscription.create({
        data: {
          business_id: businessId,
          plan_id: plan.id,
          status: BusinessSubscriptionStatus.ACTIVE,
          billing_period: period,
          starts_at: starts,
          ends_at: periodEnd(starts, period),
          payment_request_id: by.paymentRequestId ?? null,
          granted_by: by.grantedBy ?? null,
        },
        include: { plan: true },
      });
    });
    await this.syncPriority(businessId);
    return created;
  }

  // ── Quotas ───────────────────────────────────────────────────────────

  /**
   * Covers one contact unlock with the current period's quota, atomically:
   * the conditional update cannot take the last unit twice. False when there
   * is no period or the quota is used up — the fee applies (pay per unlock).
   */
  async consumeUnlock(
    employerProfileId: string,
    attemptId: string,
    db: Db = this.prisma,
  ) {
    return this.consume(
      employerProfileId,
      { contact_unlock_attempt_id: attemptId },
      db,
    );
  }

  /**
   * A direct unlock from the business's own search: covered by the same
   * quota as a mission unlock, recorded against its contact record. Never
   * released — the contact is revealed at once, there is nothing to expire.
   */
  async consumeDirectUnlock(
    employerProfileId: string,
    contactRecordId: string,
    db: Db = this.prisma,
  ) {
    return this.consume(
      employerProfileId,
      { contact_record_id: contactRecordId },
      db,
    );
  }

  private async consume(
    employerProfileId: string,
    target:
      { contact_unlock_attempt_id: string } | { contact_record_id: string },
    db: Db,
  ) {
    const businessId = await this.businessOf(employerProfileId, db);
    if (!businessId) return false;
    const sub = await this.current(businessId, db);
    if (!sub) return false;
    const quota = sub.plan.unlocks_per_period;
    const { count } = await db.businessSubscription.updateMany({
      where: {
        id: sub.id,
        ...(quota === null ? {} : { unlocks_used: { lt: quota } }),
      },
      data: { unlocks_used: { increment: 1 } },
    });
    if (count > 0) {
      await db.businessQuotaUsage.create({
        data: { subscription_id: sub.id, ...target },
      });
      return true;
    }
    // The plan's contacts are used up: one from a pack, if there is any. The
    // usage row keeps which, to give it back to that pack.
    const taken = await takeCredits(
      db,
      businessId,
      BusinessCreditKind.CONTACT,
      1,
    );
    if (!taken?.length) return false;
    await db.businessQuotaUsage.create({
      data: { subscription_id: sub.id, credit_id: taken[0].id, ...target },
    });
    return true;
  }

  /** Gives a covered unlock's unit back (it expired or was cancelled). */
  async releaseUnlock(
    attemptId: string,
    db: Db = this.prisma,
  ): Promise<boolean> {
    const usage = await db.businessQuotaUsage.findUnique({
      where: { contact_unlock_attempt_id: attemptId },
    });
    if (!usage || usage.released_at) return false;
    const { count } = await db.businessQuotaUsage.updateMany({
      where: { id: usage.id, released_at: null },
      data: { released_at: new Date() },
    });
    if (count === 0) return false;
    if (usage.credit_id) {
      const sub = await db.businessSubscription.findUnique({
        where: { id: usage.subscription_id },
        select: { business_id: true },
      });
      if (sub) {
        await giveBackCredits(
          db,
          sub.business_id,
          BusinessCreditKind.CONTACT,
          1,
          new Date(),
          usage.credit_id,
        );
      }
      return true;
    }
    await db.businessSubscription.updateMany({
      where: { id: usage.subscription_id, unlocks_used: { gt: 0 } },
      data: { unlocks_used: { decrement: 1 } },
    });
    return true;
  }

  /**
   * Charges `count` units on a period counter: the plan's room first, then
   * the packs' credits for what the plan lacks, all or nothing. An unlimited
   * quota never touches the credits. False when both together fall short.
   * `db` may be a caller's transaction; a batch from credits wants the
   * client (its own transaction), as a refusal only undoes that one.
   */
  private async charge(
    sub: { id: string; business_id: string },
    counter: Counter,
    quota: number | null,
    count: number,
    db: Db,
  ): Promise<boolean> {
    // A quota of 0 (not in the plan): straight to the packs.
    if (quota !== 0) {
      const { count: updated } = await db.businessSubscription.updateMany({
        where: {
          id: sub.id,
          ...(quota === null ? {} : { [counter]: { lte: quota - count } }),
        },
        data: { [counter]: { increment: count } },
      });
      if (updated > 0) return true;
      if (quota === null) return false;
    }
    // Two tries: a concurrent charge may take the plan's last units between
    // the read and the update.
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await db.businessSubscription.findUnique({
        where: { id: sub.id },
        select: {
          cv_screened: true,
          offers_published: true,
          offer_drafts_used: true,
        },
      });
      if (!fresh) return false;
      const room = Math.min(count, Math.max(0, quota - fresh[counter]));
      const fromCredits = count - room;
      try {
        await this.inTransaction(db, async (tx) => {
          if (room > 0) {
            const { count: ok } = await tx.businessSubscription.updateMany({
              where: {
                id: sub.id,
                [counter]: { lte: quota - room },
              },
              data: { [counter]: { increment: room } },
            });
            if (ok === 0) throw new NoRoom();
          }
          const taken = await takeCredits(
            tx,
            sub.business_id,
            CREDIT_KIND[counter],
            fromCredits,
          );
          if (!taken) throw new NoRoom();
          await tx.businessSubscription.update({
            where: { id: sub.id },
            data: { [FROM_CREDITS[counter]]: { increment: fromCredits } },
          });
        });
        return true;
      } catch (err) {
        if (!(err instanceof NoRoom)) throw err;
      }
    }
    return false;
  }

  /**
   * Gives `count` units of a counter back (work that did not happen): to
   * the packs first, as they cost money, then to the plan; never below 0.
   * One statement on the period, so a concurrent charge can't slip between.
   */
  private async giveBack(
    subscriptionId: string,
    counter: Counter,
    count: number,
    db: Db = this.prisma,
  ): Promise<void> {
    if (count <= 0) return;
    const used = Prisma.raw(`"${counter}"`);
    const fromCredits = Prisma.raw(`"${FROM_CREDITS[counter]}"`);
    const rows = await db.$queryRaw<
      { business_id: string; credited: number }[]
    >`
      WITH old AS (
        SELECT "id", ${fromCredits} AS credited
        FROM "business_subscriptions"
        WHERE "id" = ${subscriptionId}::uuid
        FOR UPDATE
      )
      UPDATE "business_subscriptions" s
      SET ${fromCredits} = s.${fromCredits} - LEAST(old.credited, ${count}::int),
          ${used} = GREATEST(s.${used} - (${count}::int - LEAST(old.credited, ${count}::int)), 0)
      FROM old
      WHERE s."id" = old."id"
      RETURNING s."business_id"::text AS business_id,
                LEAST(old.credited, ${count}::int)::int AS credited`;
    const row = rows[0];
    if (row && row.credited > 0) {
      await giveBackCredits(
        db,
        row.business_id,
        CREDIT_KIND[counter],
        row.credited,
      );
    }
  }

  /** Runs `fn` in a transaction, or in the caller's when `db` is one. */
  private inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
    return '$transaction' in db ? db.$transaction((tx) => fn(tx)) : fn(db);
  }

  /** « ou achetez un pack », when that pack is on sale. */
  private async packSold(kind: BusinessCreditKind): Promise<boolean> {
    const packs = await this.systemConfig.getBusinessPackSettings();
    const pack = packs[PACK_SETTING[kind]];
    return pack.priceFcfa > 0 && pack.quantity > 0;
  }

  /**
   * Takes `count` CVs from the current period's « CV inclus », all or none:
   * the conditional update cannot let two uploads share the last units.
   * Returns the period charged; throws when the plan has no room for them.
   */
  async consumeCv(
    businessId: string,
    count: number,
    db: Db = this.prisma,
  ): Promise<{ subscriptionId: string }> {
    const sub = await this.current(businessId, db);
    if (sub && (await this.trialLocks(sub)).has('cvAnalysis')) {
      throw new ForbiddenException(TRIAL_AI_REFUSAL);
    }
    if (!sub) {
      throw new ForbiddenException(
        'L’analyse de CV est incluse dans les formules supérieures. Changez de formule depuis votre espace, rubrique « Abonnement ».',
      );
    }
    const quota = sub.plan.cv_screenings_per_period;
    if (await this.charge(sub, 'cv_screened', quota, count, db)) {
      return { subscriptionId: sub.id };
    }
    const [balance, packSold] = await Promise.all([
      creditBalance(db, businessId),
      this.packSold(BusinessCreditKind.CV),
    ]);
    const orPack = packSold ? ' ou achetez un pack de CV' : '';
    if (quota === 0 && balance.CV === 0) {
      throw new ForbiddenException(
        `L’analyse de CV est incluse dans les formules supérieures. Changez de formule${orPack} depuis votre espace, rubrique « Abonnement ».`,
      );
    }
    const left = (remaining(quota, sub.cv_screened) ?? 0) + balance.CV;
    throw new ForbiddenException(
      left > 0
        ? `Il vous reste ${left} CV à analyser : retirez-en ${count - left}${packSold ? ', changez de formule ou achetez un pack de CV' : ' ou changez de formule'}.`
        : `Vous avez utilisé tous les CV inclus dans votre formule jusqu'au ${frenchDay(countersEnd(sub))}. Changez de formule${orPack} pour en analyser davantage.`,
    );
  }

  /**
   * One offer written by the AI, on the current period's « offres rédigées
   * par l’IA ». Conditional, like the CVs: two clicks can't share the last one.
   */
  async consumeOfferDraft(
    businessId: string,
  ): Promise<{ subscriptionId: string }> {
    const sub = await this.current(businessId);
    if (sub && (await this.trialLocks(sub)).has('offerWriter')) {
      throw new ForbiddenException(TRIAL_AI_REFUSAL);
    }
    const notIncluded =
      'La rédaction d’offres par l’IA est incluse dans les formules supérieures. Changez de formule depuis votre espace, rubrique « Abonnement ».';
    if (!sub) throw new ForbiddenException(notIncluded);
    const quota = sub.plan.offer_drafts_per_period;
    if (await this.charge(sub, 'offer_drafts_used', quota, 1, this.prisma)) {
      return { subscriptionId: sub.id };
    }
    const orPack = (await this.packSold(BusinessCreditKind.OFFER_DRAFT))
      ? ' Achetez un pack de rédactions pour en écrire davantage.'
      : '';
    throw new ForbiddenException(
      quota === 0
        ? `${notIncluded}${orPack}`
        : `Vous avez utilisé toutes les rédactions par l’IA incluses dans votre formule jusqu’au ${frenchDay(countersEnd(sub))}.${orPack}`,
    );
  }

  /** Gives back an offer the AI could not write: to its pack first. */
  async releaseOfferDraft(subscriptionId: string): Promise<void> {
    await this.giveBack(subscriptionId, 'offer_drafts_used', 1);
  }

  /** Gives back CVs that could not be read: to their pack first. */
  async releaseCv(
    subscriptionId: string,
    count: number,
    db: Db = this.prisma,
  ): Promise<void> {
    await this.giveBack(subscriptionId, 'cv_screened', count, db);
  }

  /** Throws the upgrade message when a business may not publish one more offer. */
  /**
   * Fails fast, before an offer is even validated, when the period has no
   * offer left to publish. The offer itself is charged by `consumeOffer`.
   * Non-businesses pass.
   */
  async assertCanPublishOffer(employerProfileId: string): Promise<void> {
    const businessId = await this.businessOf(employerProfileId);
    if (!businessId) return;
    const e = await this.entitlements(businessId);
    if (!e.plan) throw new ForbiddenException(NO_PLAN_TO_PUBLISH);
    if (e.offersRemaining === 0) {
      throw new ForbiddenException(
        noOfferLeft(e, await this.packSold(BusinessCreditKind.OFFER)),
      );
    }
  }

  /**
   * One offer published (or republished) on the current period, counted from 0
   * each period like the contacts and the CVs. Conditional, so two
   * publications can't share the last one. Returns the period charged, or
   * null for an employer that is not a business (no plan, no limit).
   */
  async consumeOffer(
    employerProfileId: string,
  ): Promise<{ subscriptionId: string } | null> {
    const businessId = await this.businessOf(employerProfileId);
    if (!businessId) return null;
    const sub = await this.current(businessId);
    if (!sub) throw new ForbiddenException(NO_PLAN_TO_PUBLISH);
    const quota = sub.plan.active_offers_limit;
    if (await this.charge(sub, 'offers_published', quota, 1, this.prisma)) {
      return { subscriptionId: sub.id };
    }
    throw new ForbiddenException(
      noOfferLeft(
        { plan: sub.plan, activeOffersLimit: quota },
        await this.packSold(BusinessCreditKind.OFFER),
      ),
    );
  }

  /**
   * The team's invited and active members per role, the account holder
   * aside: what a plan's « recruteurs » and « évaluateurs » limit.
   */
  async seatsInUse(
    businessId: string,
    db: Db = this.prisma,
    excludeMemberId?: string,
  ): Promise<{ recruiters: number; reviewers: number }> {
    const rows = await db.businessMember.groupBy({
      by: ['role'],
      where: {
        business_id: businessId,
        is_owner: false,
        status: { in: ['INVITED', 'ACTIVE'] },
        role: { in: ['RECRUITER', 'REVIEWER'] },
        ...(excludeMemberId ? { id: { not: excludeMemberId } } : {}),
      },
      _count: { _all: true },
    });
    const of = (role: string) =>
      rows.find((r) => r.role === role)?._count._all ?? 0;
    return { recruiters: of('RECRUITER'), reviewers: of('REVIEWER') };
  }

  /**
   * Room for one more of this role in the team: the plan's limit against
   * the people already in it (invited or active), not a per-period count —
   * which let a team grow by its limit every month, and kept a seat taken
   * after its member left. `excludeMemberId`: the member changing role, who
   * leaves the other one. Returns the period (kept on the member, for its
   * history); `message` builds the refusal from the plan's limit.
   */
  async consumeSeat(
    businessId: string,
    role: 'RECRUITER' | 'REVIEWER',
    message: (limit: number) => string,
    excludeMemberId?: string,
  ): Promise<{ subscriptionId: string }> {
    const sub = await this.current(businessId);
    const limit = !sub
      ? 0
      : role === 'RECRUITER'
        ? sub.plan.recruiters_limit
        : sub.plan.reviewers_limit;
    if (!sub || limit === 0) throw new ForbiddenException(message(0));
    if (limit !== null) {
      const used = await this.seatsInUse(
        businessId,
        this.prisma,
        excludeMemberId,
      );
      const taken = role === 'RECRUITER' ? used.recruiters : used.reviewers;
      if (taken >= limit) throw new ForbiddenException(message(limit));
    }
    return { subscriptionId: sub.id };
  }

  /** Gives back an offer that could not be saved: to its pack first. */
  async releaseOffer(subscriptionId: string): Promise<void> {
    await this.giveBack(subscriptionId, 'offers_published', 1);
  }

  /**
   * Throws unless the business has a running plan: without one it still reads
   * its conversations, but starts none and writes in none. Non-businesses pass.
   */
  async assertCanMessage(profileId: string): Promise<void> {
    await this.requirePlan(profileId, NO_PLAN_TO_MESSAGE);
  }

  /** Throws unless the business has a running plan to invite profiles to apply. Non-businesses pass. */
  async assertCanInvite(profileId: string): Promise<void> {
    await this.requirePlan(profileId, NO_PLAN_TO_INVITE);
  }

  private async requirePlan(profileId: string, message: string) {
    const businessId = await this.businessOf(profileId);
    if (!businessId) return;
    if (!(await this.current(businessId))) {
      throw new ForbiddenException(message);
    }
  }

  /** Throws unless the business's plan includes the feature. Non-businesses pass. */
  async assertFeature(
    employerProfileId: string,
    feature: 'preselection',
  ): Promise<void> {
    const businessId = await this.businessOf(employerProfileId);
    if (!businessId) return;
    const e = await this.entitlements(businessId);
    if (feature === 'preselection' && !e.includesPreselection) {
      throw new ForbiddenException(
        'La recherche de profils est incluse dans les formules supérieures. Changez de formule depuis votre espace.',
      );
    }
  }

  /** Until when a new offer of this employer shows first (null: not at all). */
  async priorityUntil(employerProfileId: string): Promise<Date | null> {
    const businessId = await this.businessOf(employerProfileId);
    if (!businessId) return null;
    return this.priorityEnd(businessId);
  }

  // ── Priority visibility ──────────────────────────────────────────────

  /** The end of the continuous run of priority periods covering now. */
  private async priorityEnd(
    businessId: string,
    now = new Date(),
  ): Promise<Date | null> {
    const periods = await this.prisma.businessSubscription.findMany({
      where: {
        business_id: businessId,
        status: { in: RUNNING },
        ends_at: { gt: now },
      },
      include: { plan: { select: { priority_visibility: true } } },
      orderBy: { starts_at: 'asc' },
    });
    const first = periods[0];
    if (!first?.plan.priority_visibility || first.starts_at > now) return null;
    let end = first.ends_at;
    for (const p of periods.slice(1)) {
      // Only a continuous run of priority periods extends it.
      if (!p.plan.priority_visibility || p.starts_at > end) break;
      if (p.ends_at > end) end = p.ends_at;
    }
    return end;
  }

  /** Puts the business's active offers' priority in line with its plans. */
  async syncPriority(businessId: string): Promise<void> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { profile_id: true },
    });
    if (!business) return;
    const until = await this.priorityEnd(businessId);
    await this.prisma.jobOffer.updateMany({
      where: { employer_id: business.profile_id, deleted_at: null },
      data: { priority_until: until },
    });
  }

  // ── Scheduled ────────────────────────────────────────────────────────

  /**
   * A payment taken whose period was never created: `onPaid` runs once, off
   * an event, and only logs when it fails (a database error, a plan moved to
   * another business since the checkout). Every approved subscription payment
   * of the last 30 days with no period is activated again here
   * (activateFromPayment is idempotent). The admins hear of one that still
   * fails, once: on the first run after it was paid. Five minutes of grace
   * leave the event its turn.
   */
  async reconcilePaidSubscriptions(
    now = new Date(),
  ): Promise<{ activated: number; failed: number }> {
    const paid = await this.prisma.paymentRequest.findMany({
      where: {
        request_type: PaymentRequestType.BUSINESS_SUBSCRIPTION,
        status: PaymentRequestStatus.APPROVED,
        updated_at: {
          gte: new Date(now.getTime() - RECONCILE_DAYS * 86_400_000),
          lte: new Date(now.getTime() - RECONCILE_GRACE_MS),
        },
      },
      select: { id: true, updated_at: true },
      orderBy: { updated_at: 'asc' },
      take: 200,
    });
    if (paid.length === 0) return { activated: 0, failed: 0 };
    const linked = new Set(
      (
        await this.prisma.businessSubscription.findMany({
          where: { payment_request_id: { in: paid.map((p) => p.id) } },
          select: { payment_request_id: true },
        })
      ).map((s) => s.payment_request_id),
    );

    let activated = 0;
    let failed = 0;
    for (const request of paid.filter((p) => !linked.has(p.id))) {
      let error: string | null = null;
      try {
        const sub = await this.activateFromPayment(request.id, now);
        if (!sub) error = 'aucune période créée';
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      if (!error) {
        activated++;
        this.logger.warn(
          `Paid subscription ${request.id} had no period: activated by the sweep`,
        );
        continue;
      }
      failed++;
      this.logger.error(
        `Paid subscription ${request.id} still has no period: ${error}`,
      );
      // Once: on the first sweep after the payment, not every hour after.
      if (
        now.getTime() - request.updated_at.getTime() <
        RECONCILE_GRACE_MS + RECONCILE_ALERT_WINDOW_MS
      ) {
        this.events.emit(AdminNotificationEvent.PAYMENT_ACTIVATION, {
          event: AdminNotificationEvent.PAYMENT_ACTIVATION,
          title: 'Subscription paid without a period',
          message: `Payment ${request.id} is confirmed but the subscription period could not be created (${error}). Grant it by hand.`,
          entityType: 'payment',
          entityId: request.id,
          timestamp: now.toISOString(),
        } satisfies AdminNotificationPayload);
      }
    }
    return { activated, failed };
  }

  /**
   * A pack paid whose credits were never added (its event is one-off, like
   * a subscription's): added here, from the last 30 days, after the grace.
   * Returns how many were added; one that keeps failing is logged.
   */
  async reconcilePaidPacks(now = new Date()): Promise<number> {
    const paid = await this.prisma.paymentRequest.findMany({
      where: {
        request_type: PaymentRequestType.BUSINESS_CREDIT_PACK,
        status: PaymentRequestStatus.APPROVED,
        updated_at: {
          gte: new Date(now.getTime() - RECONCILE_DAYS * 86_400_000),
          lte: new Date(now.getTime() - RECONCILE_GRACE_MS),
        },
      },
      select: { id: true },
      take: 200,
    });
    if (paid.length === 0) return 0;
    const added = new Set(
      (
        await this.prisma.businessCredit.findMany({
          where: { payment_request_id: { in: paid.map((p) => p.id) } },
          select: { payment_request_id: true },
        })
      ).map((c) => c.payment_request_id),
    );
    let count = 0;
    for (const request of paid.filter((p) => !added.has(p.id))) {
      try {
        if (await this.addCreditsFromPayment(request.id, now)) count++;
      } catch (err) {
        this.logger.error(`Paid pack ${request.id} still has no credits`, err);
      }
    }
    return count;
  }

  /** Reminders before the end, then expiry. Idempotent; safe to rerun. */
  async sweep(
    now = new Date(),
  ): Promise<{ reminded: number; expired: number }> {
    const settings = await this.systemConfig.getBusinessSubscriptionSettings();
    let reminded = 0;
    let expired = 0;

    const running = await this.prisma.businessSubscription.findMany({
      where: {
        status: { in: RUNNING },
        starts_at: { lte: now },
        ends_at: { gt: now },
      },
      include: { plan: true },
    });
    // The periods queued after the running ones, read once rather than one
    // query per running period.
    const queuedPeriods = await this.prisma.businessSubscription.findMany({
      where: {
        business_id: { in: [...new Set(running.map((r) => r.business_id))] },
        status: BusinessSubscriptionStatus.ACTIVE,
        starts_at: { gt: now },
      },
      select: { business_id: true, starts_at: true },
    });
    for (const sub of running) {
      // Not when the next period is already queued: nothing to renew.
      const queued = queuedPeriods.some(
        (q) => q.business_id === sub.business_id && q.starts_at >= sub.ends_at,
      );
      if (queued) continue;
      const due = dueReminder(
        now,
        sub.ends_at,
        settings.reminderDays,
        sub.reminded_at,
      );
      if (due === null) continue;
      const { count } = await this.prisma.businessSubscription.updateMany({
        where: { id: sub.id, reminded_at: sub.reminded_at },
        data: { reminded_at: now },
      });
      if (count === 0) continue;
      reminded++;
      const trial = sub.billing_period === BusinessBillingPeriod.TRIAL;
      await this.tell(
        sub.business_id,
        {
          type: 'BUSINESS_SUBSCRIPTION_EXPIRING',
          planName: sub.plan.name,
          endsAt: sub.ends_at.toISOString(),
          trial,
        },
        trial
          ? 'Votre essai Rabotka Business se termine bientôt'
          : 'Votre abonnement Rabotka Business arrive à échéance',
        (name) =>
          businessSubscriptionExpiringEmail(name, {
            planName: sub.plan.name,
            endsAt: sub.ends_at,
            trial,
            url: this.subscriptionUrl(),
          }),
      );
    }

    const lapsed = await this.prisma.businessSubscription.findMany({
      where: {
        status: { in: RUNNING },
        ends_at: { lte: now },
        expired_notified_at: null,
      },
      include: { plan: true },
    });
    for (const sub of lapsed) {
      const { count } = await this.prisma.businessSubscription.updateMany({
        where: { id: sub.id, expired_notified_at: null },
        data: {
          status: BusinessSubscriptionStatus.EXPIRED,
          expired_notified_at: now,
        },
      });
      if (count === 0) continue;
      expired++;
      await this.syncPriority(sub.business_id);
      // A queued period took over: nothing ended for the business.
      if (await this.current(sub.business_id, this.prisma, now)) continue;
      const trial = sub.billing_period === BusinessBillingPeriod.TRIAL;
      await this.tell(
        sub.business_id,
        {
          type: 'BUSINESS_SUBSCRIPTION_EXPIRED',
          planName: sub.plan.name,
          trial,
        },
        trial
          ? 'Votre essai Rabotka Business est terminé'
          : 'Votre abonnement Rabotka Business est terminé',
        (name) =>
          businessSubscriptionExpiredEmail(name, {
            planName: sub.plan.name,
            trial,
            url: this.subscriptionUrl(),
          }),
      );
    }
    return { reminded, expired };
  }

  // ── Messages ─────────────────────────────────────────────────────────

  private subscriptionUrl(): string {
    return `${appUrlFor('business')}/abonnement`;
  }

  /**
   * In-app to the business, and email to its administrator — the account
   * holder — unless it switched its e-mails off. Never throws.
   */
  private async tell(
    businessId: string,
    input: NotificationInput,
    subject: string,
    html: (name: string, businessName: string) => string,
  ): Promise<void> {
    try {
      const business = await this.prisma.business.findUnique({
        where: { id: businessId },
        select: {
          name: true,
          profile: { select: { id: true, first_name: true, email: true } },
        },
      });
      if (!business) return;
      notifyProfile(this.events, { recipientId: business.profile.id, input });
      const recipients = await businessEmailRecipients(
        this.prisma,
        businessId,
        'billing',
      );
      for (const r of recipients) {
        await this.mail.sendMail({
          to: r.email,
          subject,
          html: await this.layout.wrap(html(r.name, business.name), {
            previewText: subject,
            product: 'business',
          }),
        });
      }
    } catch (err) {
      this.logger.warn(
        `Subscription message failed for business ${businessId}`,
        err,
      );
    }
  }
}

function toPeriodView(p: {
  id: string;
  status: BusinessSubscriptionStatus;
  billing_period: BusinessBillingPeriod;
  starts_at: Date;
  ends_at: Date;
  unlocks_used: number;
  payment_request_id: string | null;
  granted_by: string | null;
  plan: { name: string; code: string };
}) {
  return {
    id: p.id,
    planName: p.plan.name,
    planCode: p.plan.code,
    status: p.status,
    billingPeriod: p.billing_period,
    startsAt: p.starts_at.toISOString(),
    endsAt: p.ends_at.toISOString(),
    unlocksUsed: p.unlocks_used,
    paid: p.payment_request_id !== null,
    granted: p.granted_by !== null,
  };
}
