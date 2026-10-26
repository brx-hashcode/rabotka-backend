import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  BusinessBillingPeriod,
  BusinessSubscriptionStatus,
  JobOfferStatus,
  PaymentRequestStatus,
  PaymentRequestType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { MailService } from '../../mail/mail.service';
import { LayoutService } from '../../mail/layout.service';
import { appUrlFor } from '../../mail/audience';
import {
  businessSubscriptionActiveEmail,
  businessSubscriptionExpiredEmail,
  businessSubscriptionExpiringEmail,
  businessTrialStartedEmail,
} from '../../mail/templates';
import { notifyProfile } from '../../profile-notification/profile-notification.events';
import type { NotificationInput } from '../../profile-notification/notification-catalog';
import {
  dueReminder,
  isUpgrade,
  nextPeriodStart,
  periodEnd,
  remaining,
  upgradedEnd,
} from './subscription-rules';
import {
  BUSINESS_SUBSCRIPTION_PAID_EVENT,
  BUSINESS_VERIFIED_EVENT,
  type BusinessSubscriptionPaidPayload,
  type BusinessVerifiedPayload,
} from './subscription.events';

type Db = Prisma.TransactionClient | PrismaService;

const RUNNING: BusinessSubscriptionStatus[] = [
  BusinessSubscriptionStatus.TRIAL,
  BusinessSubscriptionStatus.ACTIVE,
];

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
  /** Contact unlocks still covered this period; null: unlimited; 0: pay per unlock. */
  unlocksRemaining: number | null;
  unlocksQuota: number | null;
  unlocksUsed: number;
  /** Offers active at once; null: unlimited; 0: none (no plan). */
  activeOffersLimit: number | null;
  activeOffers: number;
  includesPreselection: boolean;
  includesFieldAgents: boolean;
  priorityVisibility: boolean;
};

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

  /** The period covering now (trial or paid), with its plan. */
  current(businessId: string, db: Db = this.prisma, now = new Date()) {
    return db.businessSubscription.findFirst({
      where: {
        business_id: businessId,
        status: { in: RUNNING },
        starts_at: { lte: now },
        ends_at: { gt: now },
      },
      include: { plan: true },
      orderBy: { starts_at: 'desc' },
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
            status: JobOfferStatus.ACTIVE,
            deleted_at: null,
          },
        })
      : 0;
    if (!sub) {
      return {
        plan: null,
        status: null,
        endsAt: null,
        unlocksRemaining: 0,
        unlocksQuota: 0,
        unlocksUsed: 0,
        activeOffersLimit: 0,
        activeOffers,
        includesPreselection: false,
        includesFieldAgents: false,
        priorityVisibility: false,
      };
    }
    return {
      plan: { id: sub.plan.id, code: sub.plan.code, name: sub.plan.name },
      status: sub.status,
      endsAt: sub.ends_at.toISOString(),
      unlocksRemaining: remaining(
        sub.plan.unlocks_per_period,
        sub.unlocks_used,
      ),
      unlocksQuota: sub.plan.unlocks_per_period,
      unlocksUsed: sub.unlocks_used,
      activeOffersLimit: sub.plan.active_offers_limit,
      activeOffers,
      includesPreselection: sub.plan.includes_preselection,
      includesFieldAgents: sub.plan.includes_field_agents,
      priorityVisibility: sub.plan.priority_visibility,
    };
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
      this.listPlans(true),
    ]);
    const now = new Date();
    return {
      entitlements,
      upcoming: periods
        .filter((p) => RUNNING.includes(p.status) && p.starts_at > now)
        .map(toPeriodView),
      history: periods.map(toPeriodView),
      plans,
      trialUsed: periods.some((p) => p.billing_period === 'TRIAL'),
    };
  }

  listPlans(activeOnly: boolean) {
    return this.prisma.businessPlan.findMany({
      where: activeOnly ? { is_active: true } : {},
      orderBy: [{ sort_order: 'asc' }, { monthly_price_fcfa: 'asc' }],
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Approval starts the trial (once per business, ever; none if configured off). */
  @OnEvent(BUSINESS_VERIFIED_EVENT, { async: true })
  async onBusinessVerified(payload: BusinessVerifiedPayload): Promise<void> {
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
    if (!plan || !plan.is_active) {
      this.logger.warn(
        `Trial plan « ${settings.trialPlanCode} » missing or inactive`,
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

  /** An admin grants or extends a plan by hand (stacked like a purchase). */
  async grantByAdmin(
    businessId: string,
    planId: string,
    period: BusinessBillingPeriod,
    adminUserId: string | null,
  ) {
    if (period === BusinessBillingPeriod.TRIAL) {
      throw new BadRequestException(
        'Choisissez une période mensuelle ou annuelle.',
      );
    }
    const created = await this.createPeriod(businessId, planId, period, {
      grantedBy: adminUserId,
    });
    if (!created) throw new NotFoundException('Formule introuvable.');
    await this.tell(
      businessId,
      {
        type: 'BUSINESS_SUBSCRIPTION_ACTIVE',
        planName: created.plan.name,
        endsAt: created.ends_at.toISOString(),
      },
      `Votre abonnement ${created.plan.name} est actif`,
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

  /** Ends a period now (or drops it if it had not started). No message. */
  async cancelByAdmin(
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
    });
    if (!sub)
      throw new NotFoundException('Période introuvable ou déjà terminée.');
    const now = new Date();
    await this.prisma.businessSubscription.update({
      where: { id: sub.id },
      data: {
        status: BusinessSubscriptionStatus.CANCELLED,
        granted_by: adminUserId,
        // A started period ends now; one not yet started keeps its dates.
        ...(sub.starts_at < now ? { ends_at: now } : {}),
        expired_notified_at: now,
      },
    });
    await this.syncPriority(businessId);
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
    by: { paymentRequestId?: string; grantedBy?: string | null },
    now = new Date(),
  ) {
    const plan = await this.prisma.businessPlan.findUnique({
      where: { id: planId },
    });
    if (!plan) return null;
    const created = await this.prisma.$transaction(async (tx) => {
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
      if (running && isUpgrade(running.plan, plan)) {
        const ends = upgradedEnd(now, running, { plan, period });
        await tx.businessSubscription.update({
          where: { id: running.id },
          data: {
            status: BusinessSubscriptionStatus.EXPIRED,
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
    if (count === 0) return false;
    await db.businessQuotaUsage.create({
      data: { subscription_id: sub.id, ...target },
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
    await db.businessSubscription.updateMany({
      where: { id: usage.subscription_id, unlocks_used: { gt: 0 } },
      data: { unlocks_used: { decrement: 1 } },
    });
    return true;
  }

  /** Throws the upgrade message when a business may not publish one more offer. */
  async assertCanPublishOffer(employerProfileId: string): Promise<void> {
    const businessId = await this.businessOf(employerProfileId);
    if (!businessId) return;
    const e = await this.entitlements(businessId);
    if (e.activeOffersLimit !== null && e.activeOffers >= e.activeOffersLimit) {
      throw new ForbiddenException(
        e.plan
          ? `Votre formule ${e.plan.name} permet ${e.activeOffersLimit} offre${e.activeOffersLimit > 1 ? 's' : ''} en ligne. Passez à une formule supérieure pour en publier davantage.`
          : 'Choisissez une formule depuis votre espace, rubrique « Abonnement », pour publier vos offres.',
      );
    }
  }

  /** Throws unless the business's plan includes the feature. Non-businesses pass. */
  async assertFeature(
    employerProfileId: string,
    feature: 'preselection' | 'fieldAgents',
  ): Promise<void> {
    const businessId = await this.businessOf(employerProfileId);
    if (!businessId) return;
    const e = await this.entitlements(businessId);
    const ok =
      feature === 'preselection'
        ? e.includesPreselection
        : e.includesFieldAgents;
    if (!ok) {
      throw new ForbiddenException(
        feature === 'preselection'
          ? 'La recherche de profils est incluse dans les formules supérieures. Changez de formule depuis votre espace.'
          : 'L’aide d’un agent sur le terrain est incluse dans les formules supérieures. Changez de formule depuis votre espace.',
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
    for (const sub of running) {
      // Not when the next period is already queued: nothing to renew.
      const queued = await this.prisma.businessSubscription.count({
        where: {
          business_id: sub.business_id,
          status: BusinessSubscriptionStatus.ACTIVE,
          starts_at: { gte: sub.ends_at },
        },
      });
      if (queued > 0) continue;
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

  /** In-app and email to the business's account holder. Never throws. */
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
      if (!business.profile.email) return;
      await this.mail.sendMail({
        to: business.profile.email,
        subject,
        html: await this.layout.wrap(
          html(business.profile.first_name, business.name),
          {
            previewText: subject,
            product: 'business',
          },
        ),
      });
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
