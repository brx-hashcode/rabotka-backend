import { ForbiddenException } from '@nestjs/common';
import { BusinessSubscriptionService } from '../business-subscription.service';

const plan = (over: Record<string, unknown> = {}) => ({
  id: 'plan-1',
  code: 'pro',
  name: 'Pro',
  unlocks_per_period: 2,
  active_offers_limit: 1,
  includes_preselection: false,
  includes_field_agents: false,
  priority_visibility: false,
  is_active: true,
  ...over,
});

function make(
  over: { sub?: unknown; profile?: unknown; settings?: unknown } = {},
) {
  const prisma: any = {
    profile: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          over.profile ?? { is_business: true, business: { id: 'b1' } },
        ),
    },
    business: {
      findUnique: jest.fn().mockResolvedValue({
        profile_id: 'p1',
        name: 'Akieni',
        profile: { id: 'p1', first_name: 'Awa', email: 'a@b.c' },
      }),
    },
    businessSubscription: {
      findFirst: jest.fn().mockResolvedValue(over.sub ?? null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
    },
    businessQuotaUsage: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    businessPlan: { findUnique: jest.fn().mockResolvedValue(plan()) },
    jobOffer: { count: jest.fn().mockResolvedValue(0), updateMany: jest.fn() },
    paymentRequest: { findUnique: jest.fn() },
  };
  const systemConfig: any = {
    getBusinessSubscriptionSettings: jest.fn().mockResolvedValue(
      over.settings ?? {
        trialDays: 14,
        trialPlanCode: 'pro',
        reminderDays: [7, 1],
      },
    ),
  };
  const layout: any = { wrap: jest.fn().mockResolvedValue('<html/>') };
  const mail: any = {
    sendMail: jest.fn().mockResolvedValue(undefined),
    layout,
  };
  const events: any = { emit: jest.fn() };
  return {
    service: new BusinessSubscriptionService(
      prisma,
      systemConfig,
      mail,
      layout,
      events,
    ),
    prisma,
    mail,
    events,
  };
}

/** The body handed to the mail layout on the first email sent. */
const layoutHtml = (mail: any): string => mail.layout.wrap.mock.calls[0][0];

const running = (over: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  business_id: 'b1',
  status: 'ACTIVE',
  ends_at: new Date('2099-01-01T00:00:00Z'),
  unlocks_used: 0,
  plan: plan(),
  ...over,
});

describe('BusinessSubscriptionService', () => {
  describe('consumeUnlock', () => {
    it('covers an unlock while the quota lasts, with a ledger row', async () => {
      const { service, prisma } = make({ sub: running() });
      await expect(service.consumeUnlock('p1', 'att-1')).resolves.toBe(true);
      expect(prisma.businessSubscription.updateMany).toHaveBeenCalledWith({
        where: { id: 'sub-1', unlocks_used: { lt: 2 } },
        data: { unlocks_used: { increment: 1 } },
      });
      expect(prisma.businessQuotaUsage.create).toHaveBeenCalledWith({
        data: { subscription_id: 'sub-1', contact_unlock_attempt_id: 'att-1' },
      });
    });

    it('falls back to the fee once the conditional update finds no room', async () => {
      const { service, prisma } = make({ sub: running() });
      prisma.businessSubscription.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.consumeUnlock('p1', 'att-1')).resolves.toBe(false);
      expect(prisma.businessQuotaUsage.create).not.toHaveBeenCalled();
    });

    it('has no limit when the plan quota is null', async () => {
      const { service, prisma } = make({
        sub: running({ plan: plan({ unlocks_per_period: null }) }),
      });
      await service.consumeUnlock('p1', 'att-1');
      expect(
        prisma.businessSubscription.updateMany.mock.calls[0][0].where,
      ).toEqual({ id: 'sub-1' });
    });

    it('does nothing for a regular employer or without a running period', async () => {
      const regular = make({ profile: { is_business: false, business: null } });
      await expect(regular.service.consumeUnlock('p1', 'a')).resolves.toBe(
        false,
      );
      const none = make({ sub: null });
      await expect(none.service.consumeUnlock('p1', 'a')).resolves.toBe(false);
    });
  });

  describe('releaseUnlock', () => {
    it('gives the unit back once', async () => {
      const { service, prisma } = make();
      prisma.businessQuotaUsage.findUnique.mockResolvedValue({
        id: 'u1',
        subscription_id: 'sub-1',
        released_at: null,
      });
      await expect(service.releaseUnlock('att-1')).resolves.toBe(true);
      expect(prisma.businessSubscription.updateMany).toHaveBeenCalledWith({
        where: { id: 'sub-1', unlocks_used: { gt: 0 } },
        data: { unlocks_used: { decrement: 1 } },
      });
    });

    it('is a no-op for an unlock the plan did not cover, or already released', async () => {
      const { service, prisma } = make();
      await expect(service.releaseUnlock('att-x')).resolves.toBe(false);
      prisma.businessQuotaUsage.findUnique.mockResolvedValue({
        id: 'u1',
        subscription_id: 's',
        released_at: new Date(),
      });
      await expect(service.releaseUnlock('att-1')).resolves.toBe(false);
      expect(prisma.businessSubscription.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('consumeCv', () => {
    const withCv = (over: Record<string, unknown> = {}) =>
      running({
        cv_screened: 3,
        plan: plan({ cv_screenings_per_period: 10, ...over }),
      });

    it('takes a whole batch at once, only if it all fits', async () => {
      const { service, prisma } = make({ sub: withCv() });
      await expect(service.consumeCv('b1', 4)).resolves.toEqual({
        subscriptionId: 'sub-1',
      });
      expect(prisma.businessSubscription.updateMany).toHaveBeenCalledWith({
        where: { id: 'sub-1', cv_screened: { lte: 6 } },
        data: { cv_screened: { increment: 4 } },
      });
    });

    it('says how many are left when the batch is too big', async () => {
      const { service, prisma } = make({ sub: withCv() });
      prisma.businessSubscription.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.consumeCv('b1', 9)).rejects.toThrow(
        'Il vous reste 7 CV inclus ce mois-ci : retirez-en 2',
      );
    });

    it('refuses when the plan does not include it, or there is no plan', async () => {
      const notIncluded = make({
        sub: withCv({ cv_screenings_per_period: 0 }),
      });
      await expect(notIncluded.service.consumeCv('b1', 1)).rejects.toThrow(
        ForbiddenException,
      );
      expect(
        notIncluded.prisma.businessSubscription.updateMany,
      ).not.toHaveBeenCalled();
      const none = make();
      await expect(none.service.consumeCv('b1', 1)).rejects.toThrow(
        'formules supérieures',
      );
    });

    it('has no limit when the plan says unlimited', async () => {
      const { service, prisma } = make({
        sub: withCv({ cv_screenings_per_period: null }),
      });
      await service.consumeCv('b1', 50);
      expect(
        prisma.businessSubscription.updateMany.mock.calls[0][0].where,
      ).toEqual({ id: 'sub-1' });
    });

    it('gives back in one statement, and nothing for zero', async () => {
      const { service, prisma } = make();
      prisma.$executeRaw = jest.fn().mockResolvedValue(1);
      await service.releaseCv('sub-1', 0);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      await service.releaseCv('sub-1', 2);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual([2, 'sub-1']);
    });
  });

  describe('cancelByAdmin', () => {
    it('ends the running period now and clears the queue after it', async () => {
      const { service, prisma } = make();
      const startsAt = new Date('2026-10-14T12:00:00Z');
      prisma.businessSubscription.findFirst.mockResolvedValue(
        running({ starts_at: startsAt }),
      );
      prisma.businessSubscription.update = jest.fn().mockReturnValue('end');
      prisma.$transaction = jest.fn().mockResolvedValue([]);

      await service.cancelByAdmin('b1', 'sub-1', 'admin-1');

      expect(prisma.businessSubscription.update.mock.calls[0][0]).toMatchObject(
        {
          where: { id: 'sub-1' },
          data: { status: 'CANCELLED', granted_by: 'admin-1' },
        },
      );
      expect(
        prisma.businessSubscription.update.mock.calls[0][0].data.ends_at,
      ).toBeInstanceOf(Date);
      expect(prisma.businessSubscription.updateMany).toHaveBeenCalledWith({
        where: {
          business_id: 'b1',
          status: { in: ['TRIAL', 'ACTIVE'] },
          starts_at: { gt: startsAt },
          id: { not: 'sub-1' },
        },
        data: expect.objectContaining({ status: 'CANCELLED' }),
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('keeps the dates of a period not yet started', async () => {
      const { service, prisma } = make();
      prisma.businessSubscription.findFirst.mockResolvedValue(
        running({ starts_at: new Date('2099-01-01T00:00:00Z') }),
      );
      prisma.businessSubscription.update = jest.fn().mockReturnValue('drop');
      prisma.$transaction = jest.fn().mockResolvedValue([]);

      await service.cancelByAdmin('b1', 'sub-1', null);

      expect(
        prisma.businessSubscription.update.mock.calls[0][0].data,
      ).not.toHaveProperty('ends_at');
    });

    it('tells the business in-app and by email, with the reason', async () => {
      const { service, prisma, mail, events } = make();
      prisma.businessSubscription.findFirst.mockResolvedValue(
        running({ starts_at: new Date('2026-10-14T12:00:00Z') }),
      );
      prisma.businessSubscription.update = jest.fn();
      prisma.$transaction = jest.fn().mockResolvedValue([]);

      await service.cancelByAdmin('b1', 'sub-1', 'admin-1', 'Compte <fermé>');

      expect(events.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          recipientId: 'p1',
          input: {
            type: 'BUSINESS_SUBSCRIPTION_CANCELLED',
            planName: 'Pro',
            reason: 'Compte <fermé>',
          },
        }),
      );
      expect(mail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'a@b.c',
          subject: 'Votre abonnement Pro a été arrêté',
        }),
      );
      const html = layoutHtml(mail);
      expect(html).toContain('Motif :</strong> Compte &lt;fermé&gt;');
    });

    it('leaves the motif out when no reason is given', async () => {
      const { service, prisma, mail } = make();
      prisma.businessSubscription.findFirst.mockResolvedValue(
        running({ starts_at: new Date('2026-10-14T12:00:00Z') }),
      );
      prisma.businessSubscription.update = jest.fn();
      prisma.$transaction = jest.fn().mockResolvedValue([]);

      await service.cancelByAdmin('b1', 'sub-1', null);

      expect(layoutHtml(mail)).not.toContain('Motif');
    });
  });

  describe('startQueuedNow', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    const queuedPeriod = (id: string, startDay: number, endDay: number) => ({
      id,
      business_id: 'b1',
      status: 'ACTIVE',
      billing_period: 'MONTHLY',
      starts_at: new Date(Date.UTC(2026, 10, startDay, 12)),
      ends_at: new Date(Date.UTC(2026, 11, endDay, 12)),
      unlocks_used: 0,
      payment_request_id: 'pay-1',
      granted_by: null,
      plan: plan({ name: 'Essentiel' }),
    });
    function setup(queued: unknown[]) {
      const ctx = make();
      const { prisma } = ctx;
      prisma.businessSubscription.findMany.mockResolvedValue(queued);
      prisma.businessSubscription.update = jest
        .fn()
        .mockImplementation(({ where, data }: any) => ({
          ...(queued as any[]).find((q) => q.id === where.id),
          ...data,
        }));
      prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
      return ctx;
    }

    it('ends the running period now and starts the next one for its full length', async () => {
      const next = queuedPeriod('next', 28, 28);
      const { service, prisma } = setup([next]);
      const view = await service.startQueuedNow('b1', 'next', now);

      expect(prisma.businessSubscription.updateMany).toHaveBeenCalledWith({
        where: {
          business_id: 'b1',
          status: { in: ['TRIAL', 'ACTIVE'] },
          starts_at: { lte: now },
          ends_at: { gt: now },
        },
        data: { status: 'EXPIRED', ends_at: now, expired_notified_at: now },
      });
      expect(prisma.businessSubscription.update).toHaveBeenCalledWith({
        where: { id: 'next' },
        data: { starts_at: now, ends_at: new Date('2026-11-28T12:00:00Z') },
        include: { plan: true },
      });
      expect(view).toMatchObject({
        id: 'next',
        planName: 'Essentiel',
        startsAt: now.toISOString(),
        endsAt: '2026-11-28T12:00:00.000Z',
      });
    });

    it('moves what is queued behind it up by the same amount', async () => {
      const next = queuedPeriod('next', 28, 28);
      const later = {
        ...queuedPeriod('later', 28, 28),
        starts_at: new Date('2026-12-28T12:00:00Z'),
        ends_at: new Date('2027-01-28T12:00:00Z'),
      };
      const { service, prisma } = setup([next, later]);
      await service.startQueuedNow('b1', 'next', now);
      // The next period now ends on 28 Nov instead of 28 Dec: one month earlier.
      expect(prisma.businessSubscription.update).toHaveBeenCalledWith({
        where: { id: 'later' },
        data: {
          starts_at: new Date('2026-11-28T12:00:00Z'),
          ends_at: new Date('2026-12-29T12:00:00Z'),
        },
      });
    });

    it('starts only the very next period', async () => {
      const next = queuedPeriod('next', 28, 28);
      const later = queuedPeriod('later', 28, 28);
      const { service, prisma } = setup([next, later]);
      await expect(service.startQueuedNow('b1', 'later', now)).rejects.toThrow(
        'Commencez d’abord',
      );
      await expect(service.startQueuedNow('b1', 'nope', now)).rejects.toThrow(
        'Aucune formule à venir',
      );
      expect(prisma.businessSubscription.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('consumeOfferDraft', () => {
    it('takes one on the current period, never past the plan', async () => {
      const { service, prisma } = make({
        sub: running({
          offer_drafts_used: 3,
          plan: plan({ offer_drafts_per_period: 4 }),
        }),
      });
      await expect(service.consumeOfferDraft('b1')).resolves.toEqual({
        subscriptionId: 'sub-1',
      });
      expect(prisma.businessSubscription.updateMany).toHaveBeenCalledWith({
        where: { id: 'sub-1', offer_drafts_used: { lt: 4 } },
        data: { offer_drafts_used: { increment: 1 } },
      });

      prisma.businessSubscription.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.consumeOfferDraft('b1')).rejects.toThrow(
        /toutes les rédactions/,
      );
    });

    it('is refused without a plan or with a plan that has none', async () => {
      const none = make({
        sub: running({ plan: plan({ offer_drafts_per_period: 0 }) }),
      });
      await expect(none.service.consumeOfferDraft('b1')).rejects.toThrow(
        /formules supérieures/,
      );
      const noPlan = make();
      await expect(noPlan.service.consumeOfferDraft('b1')).rejects.toThrow(
        /formules supérieures/,
      );
    });
  });

  describe('deletePlan', () => {
    const setup = () => {
      const made = make({
        settings: { trialDays: 14, trialPlanCode: 'free', reminderDays: [] },
      });
      const { service, prisma } = made;
      prisma.businessPlan.findFirst = jest
        .fn()
        .mockResolvedValue(plan({ code: 'pro' }));
      prisma.businessPlan.update = jest.fn().mockResolvedValue({});
      // b1 has a running and a queued period on the plan; b2 one period.
      prisma.businessSubscription.findMany.mockResolvedValue([
        { id: 's1', business_id: 'b1' },
        { id: 's2', business_id: 'b2' },
        { id: 's3', business_id: 'b1' },
      ]);
      const cancel = jest
        .spyOn(service as any, 'endWithQueue')
        .mockResolvedValue(undefined);
      const current = jest.spyOn(service, 'current');
      const tell = jest
        .spyOn(service as any, 'tell')
        .mockResolvedValue(undefined);
      return { ...made, cancel, current, tell };
    };

    it('hides the plan and cancels each business on it from its earliest period', async () => {
      const { service, prisma, cancel, current } = setup();
      current.mockResolvedValue(null);

      const res = await service.deletePlan('plan-1', 'admin-1');

      expect(prisma.businessPlan.update).toHaveBeenCalledWith({
        where: { id: 'plan-1' },
        data: { deleted_at: expect.any(Date), is_active: false },
      });
      expect(cancel.mock.calls).toEqual([
        ['b1', 's1', 'admin-1'],
        ['b2', 's2', 'admin-1'],
      ]);
      expect(res.businesses).toBe(2);
    });

    it('tells only the businesses left without a plan', async () => {
      const { service, current, tell } = setup();
      current
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'other' } as any);

      await service.deletePlan('plan-1', null);

      expect(tell).toHaveBeenCalledTimes(1);
      expect(tell.mock.calls[0][0]).toBe('b1');
      expect(tell.mock.calls[0][1]).toMatchObject({
        type: 'BUSINESS_SUBSCRIPTION_EXPIRED',
        planName: 'Pro',
      });
    });

    it('refuses the plan the trial setting names', async () => {
      const { service, prisma, cancel } = setup();
      prisma.businessPlan.findFirst.mockResolvedValue(plan({ code: 'free' }));

      await expect(service.deletePlan('plan-1', null)).rejects.toThrow(
        /essai gratuit/,
      );
      expect(prisma.businessPlan.update).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    });

    it('404s a plan already deleted', async () => {
      const { service, prisma } = setup();
      prisma.businessPlan.findFirst.mockResolvedValue(null);
      await expect(service.deletePlan('plan-1', null)).rejects.toThrow(
        'Formule introuvable.',
      );
    });
  });

  describe('startTrial', () => {
    it('does nothing when the trial is configured off', async () => {
      const { service, prisma } = make({
        settings: { trialDays: 0, trialPlanCode: 'pro', reminderDays: [] },
      });
      await expect(service.startTrial('b1')).resolves.toBeNull();
      expect(prisma.businessSubscription.create).not.toHaveBeenCalled();
    });

    it('never gives a second trial', async () => {
      const { service, prisma } = make({ sub: { id: 'old' } });
      await expect(service.startTrial('b1')).resolves.toBeNull();
      expect(prisma.businessSubscription.create).not.toHaveBeenCalled();
    });

    it('starts the configured plan for the configured days, and tells the business', async () => {
      const { service, prisma, mail } = make();
      const now = new Date('2026-10-01T00:00:00Z');
      prisma.businessSubscription.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 't', ...data }),
      );
      const sub = await service.startTrial('b1', now);
      expect(sub).toMatchObject({ status: 'TRIAL', billing_period: 'TRIAL' });
      expect(
        prisma.businessSubscription.create.mock.calls[0][0].data.ends_at,
      ).toEqual(new Date('2026-10-15T00:00:00Z'));
      expect(mail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'a@b.c' }),
      );
    });
  });

  describe('activateFromPayment', () => {
    it('ignores a request that is not an approved subscription payment', async () => {
      const { service, prisma } = make();
      prisma.paymentRequest.findUnique.mockResolvedValue({
        id: 'pr',
        status: 'PENDING',
        request_type: 'BUSINESS_SUBSCRIPTION',
        business_plan_id: 'plan-1',
        business_billing_period: 'MONTHLY',
        profile_id: 'p1',
      });
      await expect(service.activateFromPayment('pr')).resolves.toBeNull();
    });

    it('is idempotent on the payment request', async () => {
      const { service, prisma } = make();
      prisma.paymentRequest.findUnique.mockResolvedValue({
        id: 'pr',
        status: 'APPROVED',
        request_type: 'BUSINESS_SUBSCRIPTION',
        business_plan_id: 'plan-1',
        business_billing_period: 'MONTHLY',
        profile_id: 'p1',
      });
      prisma.businessSubscription.findUnique.mockResolvedValue({
        id: 'existing',
      });
      await expect(service.activateFromPayment('pr')).resolves.toEqual({
        id: 'existing',
      });
    });
  });

  describe('grantByAdmin (period placement)', () => {
    const cheap = plan({
      id: 'ess',
      name: 'Essentiel',
      monthly_price_fcfa: 10000,
      annual_price_fcfa: 100000,
    });
    const dear = plan({
      id: 'pro',
      name: 'Pro',
      monthly_price_fcfa: 25000,
      annual_price_fcfa: 250000,
    });
    const now = Date.now();
    const runningPeriod = (p: unknown) => ({
      id: 'old',
      starts_at: new Date(now - 15 * 86400000),
      ends_at: new Date(now + 15 * 86400000),
      billing_period: 'MONTHLY',
      plan: p,
    });
    function setup(current: unknown, next: unknown) {
      const ctx = make();
      const { prisma } = ctx;
      prisma.businessPlan.findUnique.mockResolvedValue(next);
      prisma.businessSubscription.update = jest.fn().mockResolvedValue({});
      // trial, then the running paid period, then the latest end.
      prisma.businessSubscription.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(current);

      prisma.businessSubscription.create.mockImplementation(
        ({ data }: any) => ({ ...data, plan: next }),
      );
      prisma.$transaction = (fn: (tx: unknown) => unknown) => fn(prisma);
      return ctx;
    }

    it('starts a dearer plan at once, closing the old period and moving what was queued', async () => {
      const current = runningPeriod(cheap);
      const { service, prisma } = setup(current, dear);
      prisma.businessSubscription.findMany.mockResolvedValueOnce([
        {
          id: 'queued',
          starts_at: current.ends_at,
          ends_at: new Date(now + 45 * 86400000),
        },
      ]);
      const created = await service.grantByAdmin(
        'b1',
        'pro',
        'MONTHLY',
        'admin',
      );
      expect(created.starts_at.getTime()).toBeLessThanOrEqual(Date.now());
      expect(created.starts_at.getTime()).toBeGreaterThan(now - 5000);
      expect(prisma.businessSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'old' },
          data: expect.objectContaining({ status: 'EXPIRED' }),
        }),
      );
      const moved = prisma.businessSubscription.update.mock.calls.find(
        ([a]: any) => a.where.id === 'queued',
      );
      expect(moved[0].data.starts_at).toEqual(created.ends_at);
    });

    it('queues a cheaper plan after the running one', async () => {
      const current = runningPeriod(dear);
      const { service, prisma } = setup(current, cheap);
      const created = await service.grantByAdmin(
        'b1',
        'ess',
        'MONTHLY',
        'admin',
      );
      expect(created.starts_at).toEqual(current.ends_at);
      expect(prisma.businessSubscription.update).not.toHaveBeenCalled();
    });

    it('with startNow, replaces a running dearer plan today and moves the queue', async () => {
      const current = runningPeriod(dear);
      const { service, prisma } = setup(current, cheap);
      prisma.businessSubscription.findMany.mockResolvedValueOnce([
        {
          id: 'queued',
          starts_at: current.ends_at,
          ends_at: new Date(now + 45 * 86400000),
        },
      ]);
      const created = await service.grantByAdmin(
        'b1',
        'ess',
        'MONTHLY',
        'admin',
        { startNow: true },
      );
      expect(created.starts_at.getTime()).toBeGreaterThan(now - 5000);
      expect(created.starts_at.getTime()).toBeLessThanOrEqual(Date.now());
      // A fresh month: the dearer plan's leftover days are not carried over.
      const days =
        (created.ends_at.getTime() - created.starts_at.getTime()) / 86400000;
      expect(days).toBeGreaterThanOrEqual(28);
      expect(days).toBeLessThanOrEqual(31);
      expect(prisma.businessSubscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'old' },
          data: expect.objectContaining({
            status: 'CANCELLED',
            granted_by: 'admin',
          }),
        }),
      );
      const moved = prisma.businessSubscription.update.mock.calls.find(
        ([a]: any) => a.where.id === 'queued',
      );
      expect(moved[0].data.starts_at).toEqual(created.ends_at);
    });

    it('with startNow and nothing running, starts the plan now as usual', async () => {
      const { service, prisma } = setup(null, cheap);
      const created = await service.grantByAdmin(
        'b1',
        'ess',
        'MONTHLY',
        'admin',
        { startNow: true },
      );
      expect(created.starts_at.getTime()).toBeLessThanOrEqual(Date.now());
      expect(prisma.businessSubscription.update).not.toHaveBeenCalled();
    });

    it('tells the business it was granted, never that it paid', async () => {
      const current = runningPeriod(dear);
      const { service, mail, events } = setup(current, cheap);
      await service.grantByAdmin('b1', 'ess', 'MONTHLY', 'admin');
      expect(events.emit).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          input: expect.objectContaining({
            type: 'BUSINESS_SUBSCRIPTION_GRANTED',
            planName: 'Essentiel',
            startsAt: current.ends_at.toISOString(),
          }),
        }),
      );
      const html = layoutHtml(mail);
      expect(html).toContain('prendra le relais');
      expect(html).not.toContain('paiement');
      expect(html).not.toContain('facture');
    });
  });

  describe('assertCanPublishOffer', () => {
    it('refuses once the period’s offers are published, with the upgrade message', async () => {
      const { service } = make({ sub: running({ offers_published: 1 }) });
      await expect(service.assertCanPublishOffer('p1')).rejects.toThrow(
        /par période/,
      );
    });

    it('counts the period, not the offers online', async () => {
      const { service, prisma } = make({
        sub: running({ offers_published: 0 }),
      });
      // Four online, published under a larger plan: a new period still starts at 0.
      prisma.jobOffer.count.mockResolvedValue(4);
      await expect(
        service.assertCanPublishOffer('p1'),
      ).resolves.toBeUndefined();
    });

    it('refuses a business without a plan', async () => {
      const { service } = make({ sub: null });
      await expect(service.assertCanPublishOffer('p1')).rejects.toThrow(
        /Choisissez une formule/,
      );
    });

    it('lets a regular employer through untouched', async () => {
      const { service } = make({
        profile: { is_business: false, business: null },
      });
      await expect(
        service.assertCanPublishOffer('p1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('consumeOffer', () => {
    it('charges one offer on the current period, never past the plan', async () => {
      const { service, prisma } = make({ sub: running() });
      await expect(service.consumeOffer('p1')).resolves.toEqual({
        subscriptionId: 'sub-1',
      });
      expect(prisma.businessSubscription.updateMany).toHaveBeenCalledWith({
        where: { id: 'sub-1', offers_published: { lt: 1 } },
        data: { offers_published: { increment: 1 } },
      });

      prisma.businessSubscription.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.consumeOffer('p1')).rejects.toThrow(/par période/);
    });

    it('counts without a cap on an unlimited plan', async () => {
      const { service, prisma } = make({
        sub: running({ plan: plan({ active_offers_limit: null }) }),
      });
      await service.consumeOffer('p1');
      expect(prisma.businessSubscription.updateMany).toHaveBeenCalledWith({
        where: { id: 'sub-1' },
        data: { offers_published: { increment: 1 } },
      });
    });

    it('is nothing for a regular employer, and refused without a plan', async () => {
      const regular = make({ profile: { is_business: false, business: null } });
      await expect(regular.service.consumeOffer('p1')).resolves.toBeNull();
      const noPlan = make({ sub: null });
      await expect(noPlan.service.consumeOffer('p1')).rejects.toThrow(
        /Choisissez une formule/,
      );
    });
  });

  describe('assertFeature', () => {
    it('refuses preselection when the plan lacks it, allows it when included', async () => {
      await expect(
        make({ sub: running() }).service.assertFeature('p1', 'preselection'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        make({
          sub: running({ plan: plan({ includes_preselection: true }) }),
        }).service.assertFeature('p1', 'preselection'),
      ).resolves.toBeUndefined();
    });
  });
});
