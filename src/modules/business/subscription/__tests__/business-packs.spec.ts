import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BusinessCheckoutService } from '../business-checkout.service';
import { BusinessSubscriptionService } from '../business-subscription.service';
import {
  creditExpiry,
  giveBackCredits,
  takeCredits,
} from '../business-credits';

const NOW = new Date('2026-11-06T10:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

type Credit = {
  id: string;
  kind: string;
  quantity: number;
  used: number;
  expires_at: Date;
  created_at: Date;
};

/** An in-memory business_credits table, enough for the credit functions. */
function creditsTable(rows: Credit[]) {
  const live = (where: any) =>
    rows.filter(
      (r) =>
        (!where.kind || r.kind === where.kind) &&
        (!where.id || r.id === where.id) &&
        (!where.expires_at || r.expires_at > where.expires_at.gt) &&
        (!where.used?.gt || r.used > where.used.gt),
    );
  return {
    rows,
    findMany: jest.fn(({ where, orderBy }: any) => {
      const desc = orderBy?.[0]?.expires_at === 'desc';
      return Promise.resolve(
        [...live(where)].sort(
          (a, b) =>
            (a.expires_at.getTime() - b.expires_at.getTime()) * (desc ? -1 : 1),
        ),
      );
    }),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    updateMany: jest.fn(({ where, data }: any) => {
      const r = rows.find((x) => x.id === where.id);
      const refused =
        !r ||
        (where.used?.lte !== undefined && r.used > where.used.lte) ||
        (where.used?.gte !== undefined && r.used < where.used.gte);
      if (r && !refused) r.used += data.used.increment ?? -data.used.decrement;
      return Promise.resolve({ count: refused ? 0 : 1 });
    }),
  };
}

const credit = (over: Partial<Credit>): Credit => ({
  id: 'c1',
  kind: 'CV',
  quantity: 10,
  used: 0,
  expires_at: day(300),
  created_at: day(-60),
  ...over,
});

describe('business credits', () => {
  it('spends the soonest to expire first, across packs', async () => {
    const table = creditsTable([
      credit({ id: 'late', expires_at: day(300) }),
      credit({ id: 'soon', expires_at: day(30), quantity: 3 }),
    ]);
    const taken = await takeCredits(
      { businessCredit: table } as any,
      'b1',
      'CV',
      5,
      NOW,
    );
    expect(taken).toEqual([
      { id: 'soon', count: 3 },
      { id: 'late', count: 2 },
    ]);
    expect(table.rows.map((r) => r.used)).toEqual([2, 3]);
  });

  it('takes nothing when there are not enough, and never an expired pack', async () => {
    const table = creditsTable([
      credit({ id: 'expired', expires_at: day(-1) }),
      credit({ id: 'ok', quantity: 2 }),
    ]);
    await expect(
      takeCredits({ businessCredit: table } as any, 'b1', 'CV', 3, NOW),
    ).resolves.toBeNull();
    expect(table.updateMany).not.toHaveBeenCalled();
  });

  it('gives back to the packs used last, or to the one named', async () => {
    const table = creditsTable([
      credit({ id: 'soon', expires_at: day(30), used: 3, quantity: 3 }),
      credit({ id: 'late', expires_at: day(300), used: 2 }),
    ]);
    const db = { businessCredit: table } as any;
    await expect(giveBackCredits(db, 'b1', 'CV', 3, NOW)).resolves.toBe(3);
    expect(table.rows.map((r) => r.used)).toEqual([2, 0]);
    await giveBackCredits(db, 'b1', 'CV', 1, NOW, 'soon');
    expect(table.rows.map((r) => r.used)).toEqual([1, 0]);
  });

  it('keeps a pack twelve months', () => {
    expect(creditExpiry(NOW).toISOString()).toBe('2027-11-06T10:00:00.000Z');
  });
});

const plan = (over: Record<string, unknown> = {}) => ({
  id: 'plan-1',
  code: 'pro',
  name: 'Pro',
  unlocks_per_period: 2,
  active_offers_limit: 1,
  cv_screenings_per_period: 10,
  offer_drafts_per_period: 4,
  cv_chat_questions: 0,
  cv_batch_max: 20,
  ...over,
});

const running = (over: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  business_id: 'b1',
  status: 'ACTIVE',
  billing_period: 'MONTHLY',
  starts_at: new Date(Date.now() - 86_400_000),
  counters_from: null,
  ends_at: new Date('2099-01-01T00:00:00Z'),
  unlocks_used: 0,
  cv_screened: 0,
  offers_published: 0,
  offer_drafts_used: 0,
  plan: plan(),
  ...over,
});

function make(sub: ReturnType<typeof running> | null, credits: Credit[] = []) {
  const table = creditsTable(credits);
  const prisma: any = {
    profile: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ is_business: true, business: { id: 'b1' } }),
    },
    business: {
      findUnique: jest.fn().mockResolvedValue({
        profile_id: 'p1',
        name: 'Akieni',
        profile: { id: 'p1', first_name: 'Awa', email: 'a@b.c' },
      }),
    },
    businessSubscription: {
      findFirst: jest.fn().mockResolvedValue(sub),
      findUnique: jest.fn().mockResolvedValue(sub),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    businessQuotaUsage: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    businessCredit: table,
    paymentRequest: { findUnique: jest.fn() },
    jobOffer: { count: jest.fn().mockResolvedValue(0) },
    // No team: e-mails go to the account holder.
    businessMember: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prisma));
  const systemConfig: any = {
    getBusinessPackSettings: jest.fn().mockResolvedValue({
      cv: { quantity: 50, priceFcfa: 25_000 },
      offers: { quantity: 5, priceFcfa: 0 },
      contacts: { quantity: 10, priceFcfa: 10_000 },
      offerDrafts: { quantity: 10, priceFcfa: 5_000 },
    }),
    getBusinessSubscriptionSettings: jest.fn().mockResolvedValue({
      trialAi: { cvAnalysis: false, cvChat: false, offerWriter: false },
    }),
  };
  const layout: any = { wrap: jest.fn().mockResolvedValue('<html/>') };
  const mail: any = { sendMail: jest.fn().mockResolvedValue(undefined) };
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
    table,
    events,
    mail,
    systemConfig,
  };
}

describe('BusinessSubscriptionService with packs', () => {
  it('uses the plan alone while it has room', async () => {
    const { service, table } = make(running(), [credit({})]);
    await service.consumeCv('b1', 4);
    expect(table.updateMany).not.toHaveBeenCalled();
  });

  it('fills what the plan has left, then the rest from the packs', async () => {
    const { service, prisma, table } = make(running({ cv_screened: 7 }), [
      credit({}),
    ]);
    // The whole batch does not fit the plan.
    prisma.businessSubscription.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    await expect(service.consumeCv('b1', 5)).resolves.toEqual({
      subscriptionId: 'sub-1',
    });
    expect(prisma.businessSubscription.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'sub-1', cv_screened: { lte: 7 } },
      data: { cv_screened: { increment: 3 } },
    });
    expect(table.rows[0].used).toBe(2);
    expect(prisma.businessSubscription.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: { cv_from_credits: { increment: 2 } },
    });
  });

  it('refuses with what is left, plan and packs together, and offers the pack', async () => {
    const { service, prisma, table } = make(running({ cv_screened: 9 }), [
      credit({ quantity: 2 }),
    ]);
    prisma.businessSubscription.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.consumeCv('b1', 5)).rejects.toThrow(
      'Il vous reste 3 CV à analyser : retirez-en 2, changez de formule ou achetez un pack de CV.',
    );
    expect(table.rows[0].used).toBe(0);
  });

  it('spends a pack on a plan without the feature, without touching the plan', async () => {
    const sub = running({ plan: plan({ cv_screenings_per_period: 0 }) });
    const { service, prisma, table } = make(sub, [credit({})]);
    await service.consumeCv('b1', 3);
    expect(prisma.businessSubscription.updateMany).not.toHaveBeenCalled();
    expect(table.rows[0].used).toBe(3);
  });

  it('never touches the packs on an unlimited quota', async () => {
    const sub = running({ plan: plan({ cv_screenings_per_period: null }) });
    const { service, table } = make(sub, [credit({})]);
    await service.consumeCv('b1', 30);
    expect(table.findMany).not.toHaveBeenCalled();
  });

  it('keeps the packs for a running plan', async () => {
    const { service, table } = make(null, [credit({})]);
    await expect(service.consumeCv('b1', 1)).rejects.toThrow(
      'formules supérieures',
    );
    expect(table.updateMany).not.toHaveBeenCalled();
  });

  it('gives CVs back to the pack first', async () => {
    const { service, prisma, table } = make(running(), [credit({ used: 4 })]);
    prisma.$queryRaw.mockResolvedValue([{ business_id: 'b1', credited: 2 }]);
    await service.releaseCv('sub-1', 3);
    expect(table.rows[0].used).toBe(2);
  });

  it('publishes an offer from a pack once the plan’s are published', async () => {
    const { service, prisma, table } = make(running({ offers_published: 1 }), [
      credit({ kind: 'OFFER', quantity: 5 }),
    ]);
    prisma.businessSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.consumeOffer('p1')).resolves.toEqual({
      subscriptionId: 'sub-1',
    });
    expect(table.rows[0].used).toBe(1);
  });

  it('covers a contact from a pack, and gives it back to that pack', async () => {
    const { service, prisma, table } = make(running({ unlocks_used: 2 }), [
      credit({ id: 'pack-1', kind: 'CONTACT' }),
    ]);
    prisma.businessSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.consumeUnlock('p1', 'att-1')).resolves.toBe(true);
    expect(prisma.businessQuotaUsage.create).toHaveBeenCalledWith({
      data: {
        subscription_id: 'sub-1',
        credit_id: 'pack-1',
        contact_unlock_attempt_id: 'att-1',
      },
    });
    expect(table.rows[0].used).toBe(1);

    prisma.businessQuotaUsage.findUnique.mockResolvedValue({
      id: 'u1',
      subscription_id: 'sub-1',
      credit_id: 'pack-1',
      released_at: null,
    });
    prisma.businessSubscription.updateMany.mockClear();
    await expect(service.releaseUnlock('att-1')).resolves.toBe(true);
    expect(table.rows[0].used).toBe(0);
    // The plan's counter is left alone: the contact did not come from it.
    expect(prisma.businessSubscription.updateMany).not.toHaveBeenCalled();
  });

  it('still charges the fee without a contact pack', async () => {
    const { service, prisma } = make(running({ unlocks_used: 2 }));
    prisma.businessSubscription.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.consumeUnlock('p1', 'att-1')).resolves.toBe(false);
    expect(prisma.businessQuotaUsage.create).not.toHaveBeenCalled();
  });

  it('counts the packs in what is left', async () => {
    const { service } = make(
      running({ cv_screened: 10, offers_published: 1 }),
      [
        credit({ kind: 'CV', quantity: 50, used: 5 }),
        credit({ id: 'c2', kind: 'OFFER', quantity: 5 }),
        credit({ id: 'c3', kind: 'CV', expires_at: day(-1) }),
      ],
    );
    const e = await service.entitlements('b1');
    expect(e.credits).toEqual({
      cv: 45,
      offers: 5,
      contacts: 0,
      offerDrafts: 0,
    });
    expect(e.cvRemaining).toBe(45);
    expect(e.offersRemaining).toBe(5);
    expect(e.unlocksRemaining).toBe(2);
  });

  describe('a paid pack', () => {
    const paid = {
      id: 'pr-1',
      profile_id: 'p1',
      status: 'APPROVED',
      request_type: 'BUSINESS_CREDIT_PACK',
      business_credit_kind: 'CV',
      business_credit_quantity: 100,
    };

    it('adds its credits for twelve months and tells the business', async () => {
      const { service, prisma, events, mail } = make(running());
      prisma.paymentRequest.findUnique.mockResolvedValue(paid);
      prisma.businessCredit.create.mockImplementation(({ data }: any) =>
        Promise.resolve({ ...data, id: 'c9' }),
      );
      await service.addCreditsFromPayment('pr-1', NOW);
      expect(prisma.businessCredit.create).toHaveBeenCalledWith({
        data: {
          business_id: 'b1',
          kind: 'CV',
          quantity: 100,
          expires_at: new Date('2027-11-06T10:00:00Z'),
          payment_request_id: 'pr-1',
        },
      });
      expect(events.emit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          recipientId: 'p1',
          input: expect.objectContaining({
            type: 'BUSINESS_CREDITS_ADDED',
            what: '100 CV à analyser',
          }),
        }),
      );
      expect(mail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ subject: 'Pack ajouté : 100 CV à analyser' }),
      );
    });

    it('adds them once', async () => {
      const { service, prisma } = make(running());
      prisma.paymentRequest.findUnique.mockResolvedValue(paid);
      prisma.businessCredit.findUnique.mockResolvedValue({ id: 'c9' });
      await service.addCreditsFromPayment('pr-1', NOW);
      expect(prisma.businessCredit.create).not.toHaveBeenCalled();
    });

    it('ignores a request that is not a paid pack', async () => {
      const { service, prisma } = make(running());
      prisma.paymentRequest.findUnique.mockResolvedValue({
        ...paid,
        status: 'PENDING',
      });
      await expect(service.addCreditsFromPayment('pr-1')).resolves.toBeNull();
      expect(prisma.businessCredit.create).not.toHaveBeenCalled();
    });
  });

  it('lists the packs on sale and what is left of those bought', async () => {
    const { service } = make(running(), [
      credit({ id: 'c1', used: 4 }),
      credit({ id: 'c2', used: 10 }),
    ]);
    const packs = await service.packs('b1', NOW);
    expect(packs.onSale.map((p) => p.kind)).toEqual([
      'CV',
      'CONTACT',
      'OFFER_DRAFT',
    ]);
    expect(packs.credits).toEqual([
      expect.objectContaining({ id: 'c1', kind: 'CV', quantity: 10, left: 6 }),
    ]);
  });
});

describe('BusinessCheckoutService.buyPack', () => {
  function checkout(sub: unknown) {
    const { service, systemConfig } = make(sub as any);
    const paymentRequests: any = {
      createPaymentUrl: jest.fn((...args: any[]) => {
        args[4].urlFor('tok-1');
        return Promise.resolve('url');
      }),
    };
    return {
      checkout: new BusinessCheckoutService(
        {} as any,
        paymentRequests,
        service,
        systemConfig,
      ),
      paymentRequests,
    };
  }

  it('prices the packs from the settings', async () => {
    const { checkout: c, paymentRequests } = checkout(running());
    await expect(c.buyPack('p1', 'CV', 2)).resolves.toEqual({
      token: 'tok-1',
      amount: 50_000,
    });
    expect(paymentRequests.createPaymentUrl).toHaveBeenCalledWith(
      'p1',
      50_000,
      'Pack Rabotka Business — 100 CV à analyser',
      'BUSINESS_CREDIT_PACK',
      expect.objectContaining({ creditPack: { kind: 'CV', quantity: 100 } }),
    );
  });

  it('refuses a pack not on sale, and a business without a plan', async () => {
    await expect(
      checkout(running()).checkout.buyPack('p1', 'OFFER', 1),
    ).rejects.toThrow(NotFoundException);
    await expect(
      checkout(null).checkout.buyPack('p1', 'CV', 1),
    ).rejects.toThrow(BadRequestException);
  });
});
