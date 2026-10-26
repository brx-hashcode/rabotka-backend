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
      findUnique: jest
        .fn()
        .mockResolvedValue({
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
    getBusinessSubscriptionSettings: jest
      .fn()
      .mockResolvedValue(
        over.settings ?? {
          trialDays: 14,
          trialPlanCode: 'pro',
          reminderDays: [7, 1],
        },
      ),
  };
  const mail: any = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const layout: any = { wrap: jest.fn().mockResolvedValue('<html/>') };
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
  };
}

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
  });

  describe('assertCanPublishOffer', () => {
    it('refuses past the plan limit, with the upgrade message', async () => {
      const { service, prisma } = make({ sub: running() });
      prisma.jobOffer.count.mockResolvedValue(1);
      await expect(service.assertCanPublishOffer('p1')).rejects.toThrow(
        ForbiddenException,
      );
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
