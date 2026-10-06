import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentLedgerBucket,
  AgentLedgerKind,
  AgentMomoOperator,
  AgentStatus,
  AgentWithdrawalStatus,
  Prisma,
} from '@prisma/client';
import {
  AgentWithdrawalService,
  normalizeMomoPhone,
  startOfBrazzavilleMonth,
} from '../agent-withdrawal.service';

const AGENT = {
  id: 'agent-1',
  first_name: 'Jean',
  last_name: 'K',
  avatar_url: null,
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'wd-1',
    created_at: new Date(),
    amount: new Prisma.Decimal(2000),
    momo_phone: '+242061111111',
    momo_operator: AgentMomoOperator.MTN,
    status: AgentWithdrawalStatus.REQUESTED,
    processed_at: null,
    provider_reference: null,
    rejection_reason: null,
    agent: { ...AGENT, email: 'jean@example.com' },
    ...over,
  };
}

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('startOfBrazzavilleMonth', () => {
  it('starts the month at midnight UTC+1', () => {
    expect(
      startOfBrazzavilleMonth(new Date('2026-10-04T12:00:00Z')).toISOString(),
    ).toBe('2026-09-30T23:00:00.000Z');
    // 23:30 UTC on Oct 31 is already November in Brazzaville.
    expect(
      startOfBrazzavilleMonth(new Date('2026-10-31T23:30:00Z')).toISOString(),
    ).toBe('2026-10-31T23:00:00.000Z');
  });
});

describe('normalizeMomoPhone', () => {
  it('reads a typed number as E.164', () => {
    expect(normalizeMomoPhone('+242 06 111 11 11')).toBe('+242061111111');
  });

  it('refuses a local number with no country code', () => {
    // toE164 does not guess +242; "+05…" is not a number anyone owns.
    expect(() => normalizeMomoPhone('05 999 99 99')).toThrow(
      BadRequestException,
    );
  });

  it('refuses something that is not a number', () => {
    expect(() => normalizeMomoPhone('mon numéro')).toThrow(BadRequestException);
  });
});

describe('AgentWithdrawalService', () => {
  let prisma: any;
  let systemConfig: { getAgentWithdrawalMinFcfa: jest.Mock };
  let logService: { create: jest.Mock };
  let mail: { sendMail: jest.Mock };
  let events: { emit: jest.Mock };
  let service: AgentWithdrawalService;

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      agent: {
        findUnique: jest.fn().mockResolvedValue({
          status: AgentStatus.ACTIVE,
          phone: '+242061111111',
        }),
      },
      agentWithdrawal: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(({ data }) =>
          row({
            amount: new Prisma.Decimal(data.amount),
            momo_phone: data.momo_phone,
          }),
        ),
        findUnique: jest.fn().mockResolvedValue({
          id: 'wd-1',
          agent_id: 'agent-1',
          amount: new Prisma.Decimal(2000),
          status: AgentWithdrawalStatus.REQUESTED,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(row()),
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest
          .fn()
          .mockResolvedValue({ _count: { _all: 0 }, _sum: { amount: null } }),
        groupBy: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      agentLedgerEntry: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 3000 } }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prisma));
    systemConfig = {
      getAgentWithdrawalMinFcfa: jest.fn().mockResolvedValue(2000),
    };
    logService = { create: jest.fn().mockResolvedValue(undefined) };
    mail = { sendMail: jest.fn().mockResolvedValue(undefined) };
    events = { emit: jest.fn() };
    const layout = { wrap: jest.fn((html: string) => Promise.resolve(html)) };
    service = new AgentWithdrawalService(
      prisma,
      systemConfig as any,
      logService as any,
      mail as any,
      layout as any,
      events as any,
    );
  });

  const ledgerRows = () =>
    prisma.agentLedgerEntry.createMany.mock.calls.flatMap(
      (c: any[]) => c[0].data,
    );

  describe('request', () => {
    const ask = (over: Record<string, unknown> = {}) =>
      service.request('agent-1', {
        amount: 2000,
        momoOperator: AgentMomoOperator.MTN,
        ...over,
      });

    it("locks the amount, paid to the agent's own number by default", async () => {
      const result = await ask();

      expect(prisma.$queryRaw).toHaveBeenCalled(); // row lock
      expect(prisma.agentWithdrawal.create.mock.calls[0][0].data).toEqual({
        agent_id: 'agent-1',
        amount: 2000,
        momo_phone: '+242061111111',
        momo_operator: AgentMomoOperator.MTN,
      });
      expect(ledgerRows()).toEqual([
        expect.objectContaining({
          kind: AgentLedgerKind.WITHDRAWAL_REQUESTED,
          bucket: AgentLedgerBucket.AVAILABLE,
          amount: -2000,
          idempotency_key: 'withdrawal:wd-1:requested:available',
        }),
        expect.objectContaining({
          bucket: AgentLedgerBucket.LOCKED,
          amount: 2000,
          idempotency_key: 'withdrawal:wd-1:requested:locked',
        }),
      ]);
      expect(result).toMatchObject({ amount: 2000, status: 'REQUESTED' });
      expect(events.emit).toHaveBeenCalledWith(
        'admin.notification.agent.withdrawal_requested',
        expect.objectContaining({
          entityType: 'agent-withdrawal',
          entityId: 'wd-1',
          // fr-FR groups thousands with a narrow no-break space.
          message: expect.stringMatching(
            /^Jean K demande 2\s000 FCFA \(MTN\)$/,
          ),
        }),
      );
    });

    it('pays another number when given one', async () => {
      await ask({ momoPhone: '242 05 999 99 99' });
      expect(
        prisma.agentWithdrawal.create.mock.calls[0][0].data.momo_phone,
      ).toBe('+242059999999');
    });

    it('refuses less than the minimum', async () => {
      await expect(ask({ amount: 1500 })).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses more than the available balance', async () => {
      await expect(ask({ amount: 5000 })).rejects.toThrow(BadRequestException);
      expect(prisma.agentWithdrawal.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('refuses a second open request', async () => {
      prisma.agentWithdrawal.count.mockResolvedValue(1);
      await expect(ask()).rejects.toThrow(ConflictException);
    });

    it('reads the partial index firing as a second open request', async () => {
      prisma.agentWithdrawal.create.mockRejectedValue(p2002());
      await expect(ask()).rejects.toThrow(ConflictException);
    });

    it('refuses a suspended agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        status: AgentStatus.SUSPENDED,
        phone: '+242061111111',
      });
      await expect(ask()).rejects.toThrow(ForbiddenException);
    });
  });

  describe('pay', () => {
    it('moves the amount to paid out, records the reference, emails the agent', async () => {
      await service.pay('wd-1', 'admin-1', '  MP2610.1234  ');

      expect(prisma.agentWithdrawal.updateMany).toHaveBeenCalledWith({
        where: { id: 'wd-1', status: AgentWithdrawalStatus.REQUESTED },
        data: expect.objectContaining({
          status: AgentWithdrawalStatus.PAID,
          processed_by_user_id: 'admin-1',
          provider_reference: 'MP2610.1234',
        }),
      });
      expect(ledgerRows()).toEqual([
        expect.objectContaining({
          bucket: AgentLedgerBucket.LOCKED,
          amount: -2000,
        }),
        expect.objectContaining({
          bucket: AgentLedgerBucket.PAID_OUT,
          amount: 2000,
        }),
      ]);
      expect(mail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'jean@example.com' }),
      );
      expect(logService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AGENT_WITHDRAWAL_PAID',
          userId: 'admin-1',
        }),
      );
    });

    it('refuses a reference already used for another withdrawal', async () => {
      prisma.agentWithdrawal.updateMany.mockRejectedValue(p2002());
      await expect(service.pay('wd-1', 'admin-1', 'MP1')).rejects.toThrow(
        'Cette référence a déjà servi',
      );
    });

    it('refuses one already processed, moving no money', async () => {
      prisma.agentWithdrawal.findUnique.mockResolvedValue({
        id: 'wd-1',
        agent_id: 'agent-1',
        amount: new Prisma.Decimal(2000),
        status: AgentWithdrawalStatus.PAID,
      });
      await expect(service.pay('wd-1', 'admin-1', 'MP1')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.agentLedgerEntry.createMany).not.toHaveBeenCalled();
    });

    it('loses a race with another admin cleanly', async () => {
      prisma.agentWithdrawal.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.pay('wd-1', 'admin-1', 'MP1')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.agentLedgerEntry.createMany).not.toHaveBeenCalled();
    });

    it('still records the payment when the email fails', async () => {
      mail.sendMail.mockRejectedValue(new Error('smtp down'));
      await expect(
        service.pay('wd-1', 'admin-1', 'MP1'),
      ).resolves.toMatchObject({
        id: 'wd-1',
      });
    });
  });

  describe('reject', () => {
    it('gives the amount back to the available balance and says why', async () => {
      await service.reject('wd-1', 'admin-1', 'Numéro invalide');

      expect(
        prisma.agentWithdrawal.updateMany.mock.calls[0][0].data,
      ).toMatchObject({
        status: AgentWithdrawalStatus.REJECTED,
        rejection_reason: 'Numéro invalide',
      });
      expect(ledgerRows()).toEqual([
        expect.objectContaining({
          bucket: AgentLedgerBucket.LOCKED,
          amount: -2000,
        }),
        expect.objectContaining({
          bucket: AgentLedgerBucket.AVAILABLE,
          amount: 2000,
        }),
      ]);
      expect(mail.sendMail.mock.calls[0][0].html).toContain('Numéro invalide');
    });
  });

  describe('cancel', () => {
    beforeEach(() => {
      prisma.agentWithdrawal.findFirst.mockResolvedValue({
        id: 'wd-1',
        amount: new Prisma.Decimal(2000),
        status: AgentWithdrawalStatus.REQUESTED,
      });
    });

    it('gives the amount back to the available balance, without an email', async () => {
      await service.cancel('agent-1', 'wd-1');

      expect(prisma.agentWithdrawal.findFirst.mock.calls[0][0].where).toEqual({
        id: 'wd-1',
        agent_id: 'agent-1',
      });
      expect(prisma.agentWithdrawal.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'wd-1', status: AgentWithdrawalStatus.REQUESTED },
        data: { status: AgentWithdrawalStatus.CANCELLED },
      });
      expect(ledgerRows()).toEqual([
        expect.objectContaining({
          kind: AgentLedgerKind.WITHDRAWAL_CANCELLED,
          bucket: AgentLedgerBucket.LOCKED,
          amount: -2000,
          idempotency_key: 'withdrawal:wd-1:cancelled:locked',
        }),
        expect.objectContaining({
          kind: AgentLedgerKind.WITHDRAWAL_CANCELLED,
          bucket: AgentLedgerBucket.AVAILABLE,
          amount: 2000,
        }),
      ]);
      expect(logService.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'AGENT_WITHDRAWAL_CANCELLED' }),
      );
      expect(mail.sendMail).not.toHaveBeenCalled();
    });

    it("reads another agent's request as not found", async () => {
      prisma.agentWithdrawal.findFirst.mockResolvedValue(null);
      await expect(service.cancel('agent-2', 'wd-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.agentWithdrawal.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a request an admin already decided, moving no money', async () => {
      prisma.agentWithdrawal.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.cancel('agent-1', 'wd-1')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.agentLedgerEntry.createMany).not.toHaveBeenCalled();
    });
  });

  it('names the admin who processed it for admins only', async () => {
    prisma.agentWithdrawal.findMany.mockResolvedValue([
      row({
        status: AgentWithdrawalStatus.PAID,
        provider_reference: 'MP1',
        processed_by_user_id: 'admin-1',
      }),
    ]);
    prisma.user = {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'admin-1', first_name: 'Awa', last_name: 'N' },
        ]),
    };

    const admin = await service.list({ page: 1, limit: 20, forAdmin: true });
    expect(admin.data[0]).toMatchObject({ processedBy: 'Awa N' });

    const agent = await service.list({
      agentId: 'agent-1',
      page: 1,
      limit: 20,
    });
    expect(agent.data[0]).not.toHaveProperty('processedBy');
    expect(agent.data[0]).not.toHaveProperty('processed_by_user_id');
  });

  it('sums what waits per network, and what went out this month', async () => {
    const oldest = new Date('2026-10-02T09:00:00Z');
    prisma.agentWithdrawal.groupBy
      .mockResolvedValueOnce([
        { status: AgentWithdrawalStatus.REQUESTED, _count: { _all: 3 } },
        { status: AgentWithdrawalStatus.PAID, _count: { _all: 5 } },
      ])
      .mockResolvedValueOnce([
        {
          momo_operator: 'MTN',
          _count: { _all: 2 },
          _sum: { amount: new Prisma.Decimal(3500) },
        },
        {
          momo_operator: 'AIRTEL',
          _count: { _all: 1 },
          _sum: { amount: new Prisma.Decimal(3500) },
        },
      ]);
    prisma.agentWithdrawal.findFirst.mockResolvedValue({ created_at: oldest });
    prisma.agentWithdrawal.aggregate.mockResolvedValue({
      _count: { _all: 4 },
      _sum: { amount: new Prisma.Decimal(9500) },
    });

    await expect(service.summary()).resolves.toEqual({
      counts: { REQUESTED: 3, PAID: 5, REJECTED: 0, CANCELLED: 0 },
      open: {
        count: 3,
        amount: 7000,
        oldestAt: oldest,
        byOperator: {
          MTN: { count: 2, amount: 3500 },
          AIRTEL: { count: 1, amount: 3500 },
        },
      },
      paidThisMonth: { count: 4, amount: 9500 },
    });
  });

  it('reads the queue day by day: backlog, paid and rejected', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        date: '2026-10-03',
        open_count: 2,
        open_amount: 3000,
        paid_count: 1,
        paid_amount: 2000,
        rejected_count: 1,
        rejected_amount: 500,
      },
    ]);
    await expect(service.timeseries(7)).resolves.toEqual({
      days: 7,
      points: [
        {
          date: '2026-10-03',
          toPay: { count: 2, amount: 3000 },
          paid: { count: 1, amount: 2000 },
          rejected: { count: 1, amount: 500 },
        },
      ],
    });
  });

  it('works the queue oldest first, and history newest first', async () => {
    await service.list({
      status: AgentWithdrawalStatus.REQUESTED,
      page: 1,
      limit: 20,
    });
    await service.list({ agentId: 'agent-1', page: 1, limit: 20 });
    const orders = prisma.agentWithdrawal.findMany.mock.calls.map(
      (c: any[]) => c[0].orderBy.created_at,
    );
    expect(orders).toEqual(['asc', 'desc']);
  });
});
