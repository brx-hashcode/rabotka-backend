import { ConflictException } from '@nestjs/common';
import {
  AgentCommissionStatus,
  AgentLedgerBucket,
  AgentLedgerKind,
  AgentStatus,
  AssignmentStatus,
  ContactUnlockStatus,
  PaymentRequestType,
  Prisma,
} from '@prisma/client';
import { AgentCommissionService } from '../agent-commission.service';

const HOUR = 60 * 60 * 1000;
const UNLOCKED_AT = new Date('2026-10-01T10:00:00Z');

const SETTINGS = {
  amountFcfa: 400,
  releaseEvent: 'UNLOCKED' as const,
  confirmationHours: 72,
  requiresMomoWorker: true,
  requiresMomoEmployer: true,
  multiSeatMode: 'PER_PLACEMENT' as const,
};

function attempt(over: Record<string, unknown> = {}) {
  return {
    id: 'att-1',
    status: ContactUnlockStatus.UNLOCKED,
    application_id: 'app-1',
    job_offer_id: 'job-1',
    worker_id: 'w1',
    employer_id: 'e1',
    unlocked_at: UNLOCKED_AT,
    application: { agent_id: 'agent-1' },
    job_offer: { quantity: 1, employer_unlock_paid: false },
    worker: { phone: '+242062222222', direct_phone: null },
    employer: { phone: '+242063333333' },
    ...over,
  };
}

const momo = (profile_id: string, attemptId = 'att-1') => ({
  profile_id,
  request_type: PaymentRequestType.CONTACT_UNLOCK,
  contact_unlock_attempt_id: attemptId,
});
const credit = (profile_id: string, attemptId = 'att-1') => ({
  profile_id,
  request_type: null,
  contact_unlock_attempt_id: attemptId,
});

function pending(over: Record<string, unknown> = {}) {
  return {
    id: 'com-1',
    agent_id: 'agent-1',
    application_id: 'app-1',
    contact_unlock_attempt_id: 'att-1',
    job_offer_id: 'job-1',
    worker_id: 'w1',
    amount: new Prisma.Decimal(400),
    available_at: new Date(Date.now() - HOUR),
    ...over,
  };
}

describe('AgentCommissionService', () => {
  let prisma: any;
  let systemConfig: { getAgentCommissionSettings: jest.Mock };
  let logService: { create: jest.Mock };
  let service: AgentCommissionService;

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'att-1' }]),
      contactUnlockAttempt: {
        findUnique: jest.fn().mockResolvedValue(attempt()),
        findMany: jest.fn().mockResolvedValue([]),
      },
      agent: {
        findUnique: jest.fn().mockResolvedValue({
          status: AgentStatus.ACTIVE,
          phone: '+242061111111',
        }),
      },
      paymentRequest: {
        findMany: jest.fn().mockResolvedValue([momo('w1'), momo('e1')]),
      },
      agentCommission: {
        create: jest
          .fn()
          .mockImplementation(({ data }) => ({ id: 'com-1', ...data })),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      agentLedgerEntry: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 1000 } }),
      },
      assignment: { findMany: jest.fn().mockResolvedValue([]) },
      jobOffer: { findMany: jest.fn().mockResolvedValue([]) },
      profile: { findMany: jest.fn().mockResolvedValue([]) },
    };
    prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prisma));
    systemConfig = {
      getAgentCommissionSettings: jest.fn().mockResolvedValue(SETTINGS),
    };
    logService = { create: jest.fn().mockResolvedValue(undefined) };
    service = new AgentCommissionService(
      prisma,
      systemConfig as any,
      logService as any,
    );
  });

  const ledgerRows = () =>
    prisma.agentLedgerEntry.createMany.mock.calls.flatMap(
      (c: any[]) => c[0].data,
    );

  describe('deciding a placement', () => {
    it('earns a pending commission, withdrawable after the window', async () => {
      await expect(service.decideNewPlacements()).resolves.toBe(1);

      const { data } = prisma.agentCommission.create.mock.calls[0][0];
      expect(data).toMatchObject({
        agent_id: 'agent-1',
        application_id: 'app-1',
        contact_unlock_attempt_id: 'att-1',
        amount: 400,
        status: AgentCommissionStatus.PENDING,
      });
      expect(data.available_at.getTime()).toBe(
        UNLOCKED_AT.getTime() + 72 * HOUR,
      );
      expect(ledgerRows()).toEqual([
        expect.objectContaining({
          kind: AgentLedgerKind.COMMISSION_EARNED,
          bucket: AgentLedgerBucket.PENDING,
          amount: 400,
          idempotency_key: 'commission:com-1:earned',
        }),
      ]);
    });

    it('waits for the mission when the window starts at completion', async () => {
      systemConfig.getAgentCommissionSettings.mockResolvedValue({
        ...SETTINGS,
        releaseEvent: 'COMPLETED',
      });
      await service.decideNewPlacements();
      expect(
        prisma.agentCommission.create.mock.calls[0][0].data.available_at,
      ).toBeNull();
    });

    it('records an ineligible placement with its reason and moves no money', async () => {
      prisma.paymentRequest.findMany.mockResolvedValue([
        credit('w1'),
        momo('e1'),
      ]);
      await service.decideNewPlacements();

      expect(prisma.agentCommission.create.mock.calls[0][0].data).toMatchObject(
        {
          amount: 0,
          status: AgentCommissionStatus.INELIGIBLE,
          reason: "Le travailleur n'a pas payé par Mobile Money",
        },
      );
      expect(prisma.agentLedgerEntry.createMany).not.toHaveBeenCalled();
    });

    it("finds a multi-seat employer's payment on another seat's unlock", async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        attempt({ job_offer: { quantity: 3, employer_unlock_paid: true } }),
      );
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([
        { id: 'att-0' },
        { id: 'att-1' },
      ]);
      prisma.paymentRequest.findMany.mockResolvedValue([
        momo('w1'),
        momo('e1', 'att-0'),
      ]);

      await service.decideNewPlacements();

      const where = prisma.paymentRequest.findMany.mock.calls[0][0].where;
      expect(where.OR[1]).toEqual({
        profile_id: 'e1',
        contact_unlock_attempt_id: { in: ['att-0', 'att-1'] },
      });
      expect(prisma.agentCommission.create.mock.calls[0][0].data.status).toBe(
        AgentCommissionStatus.PENDING,
      );
    });

    it('in FIRST_ONLY, pays only the seat that carried the payment', async () => {
      systemConfig.getAgentCommissionSettings.mockResolvedValue({
        ...SETTINGS,
        multiSeatMode: 'FIRST_ONLY',
      });
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        attempt({ job_offer: { quantity: 3, employer_unlock_paid: true } }),
      );
      prisma.paymentRequest.findMany.mockResolvedValue([
        momo('w1'),
        momo('e1', 'att-0'),
      ]);

      await service.decideNewPlacements();
      expect(prisma.agentCommission.create.mock.calls[0][0].data.status).toBe(
        AgentCommissionStatus.INELIGIBLE,
      );
    });

    it('lets a concurrent sweep win without failing', async () => {
      prisma.agentCommission.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(service.decideNewPlacements()).resolves.toBe(0);
    });

    it('decides nothing when there is nothing new', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.decideNewPlacements()).resolves.toBe(0);
      expect(systemConfig.getAgentCommissionSettings).not.toHaveBeenCalled();
    });
  });

  describe('starting the window at completion', () => {
    it('uses the hours the commission was earned under', async () => {
      const completedAt = new Date('2026-10-05T12:00:00Z');
      prisma.agentCommission.findMany.mockResolvedValue([
        {
          id: 'com-1',
          application_id: 'app-1',
          rules_snapshot: { ...SETTINGS, confirmationHours: 24 },
        },
      ]);
      prisma.assignment.findMany.mockResolvedValue([
        { application_id: 'app-1', completed_at: completedAt },
      ]);

      await expect(service.startCompletionWindows()).resolves.toBe(1);
      expect(prisma.agentCommission.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'com-1',
          status: AgentCommissionStatus.PENDING,
          available_at: null,
        },
        data: { available_at: new Date(completedAt.getTime() + 24 * HOUR) },
      });
    });
  });

  describe('settling pending commissions', () => {
    it('releases a commission whose window has passed', async () => {
      prisma.agentCommission.findMany.mockResolvedValue([pending()]);
      prisma.assignment.findMany.mockResolvedValue([
        { application_id: 'app-1', status: AssignmentStatus.CONFIRMED },
      ]);

      await expect(service.settlePending()).resolves.toEqual({
        released: 1,
        cancelled: 0,
      });
      expect(ledgerRows()).toEqual([
        expect.objectContaining({
          bucket: AgentLedgerBucket.PENDING,
          amount: -400,
          idempotency_key: 'commission:com-1:released:pending',
        }),
        expect.objectContaining({
          bucket: AgentLedgerBucket.AVAILABLE,
          amount: 400,
          idempotency_key: 'commission:com-1:released:available',
        }),
      ]);
    });

    it('leaves one still in its window alone', async () => {
      prisma.agentCommission.findMany.mockResolvedValue([
        pending({ available_at: new Date(Date.now() + HOUR) }),
      ]);
      await expect(service.settlePending()).resolves.toEqual({
        released: 0,
        cancelled: 0,
      });
      expect(prisma.agentCommission.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      [AssignmentStatus.NO_SHOW, 'Le travailleur ne s’est pas présenté'],
      [AssignmentStatus.CANCELLED_BY_EMPLOYER, 'Mission annulée'],
    ])('cancels on %s, even before the window ends', async (status, reason) => {
      prisma.agentCommission.findMany.mockResolvedValue([
        pending({ available_at: new Date(Date.now() + HOUR) }),
      ]);
      prisma.assignment.findMany.mockResolvedValue([
        { application_id: 'app-1', status },
      ]);

      await expect(service.settlePending()).resolves.toEqual({
        released: 0,
        cancelled: 1,
      });
      expect(
        prisma.agentCommission.updateMany.mock.calls[0][0].data,
      ).toMatchObject({
        status: AgentCommissionStatus.CANCELLED,
        reason,
      });
      expect(ledgerRows()).toEqual([
        expect.objectContaining({
          kind: AgentLedgerKind.COMMISSION_CANCELLED,
          bucket: AgentLedgerBucket.PENDING,
          amount: -400,
        }),
      ]);
    });

    it('moves no money when another sweep already settled it', async () => {
      prisma.agentCommission.findMany.mockResolvedValue([pending()]);
      prisma.agentCommission.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.settlePending()).resolves.toEqual({
        released: 0,
        cancelled: 0,
      });
      expect(prisma.agentLedgerEntry.createMany).not.toHaveBeenCalled();
    });
  });

  describe('admin cancellation', () => {
    const row = (status: AgentCommissionStatus) => ({
      ...pending(),
      status,
    });

    it('takes an available commission back from the available balance', async () => {
      prisma.agentCommission.findFirst.mockResolvedValue(
        row(AgentCommissionStatus.AVAILABLE),
      );
      await service.adminCancel(
        'agent-1',
        'com-1',
        'Faux placement',
        'admin-1',
      );

      expect(prisma.$queryRaw).toHaveBeenCalled(); // row lock on the agent
      expect(ledgerRows()).toEqual([
        expect.objectContaining({
          bucket: AgentLedgerBucket.AVAILABLE,
          amount: -400,
          description: 'Faux placement',
        }),
      ]);
    });

    it('refuses when the available balance no longer covers it', async () => {
      prisma.agentCommission.findFirst.mockResolvedValue(
        row(AgentCommissionStatus.AVAILABLE),
      );
      prisma.agentLedgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: 100 },
      });
      await expect(
        service.adminCancel('agent-1', 'com-1', 'Faux placement', 'admin-1'),
      ).rejects.toThrow(ConflictException);
      expect(prisma.agentLedgerEntry.createMany).not.toHaveBeenCalled();
    });

    it('refuses a commission that is already settled', async () => {
      prisma.agentCommission.findFirst.mockResolvedValue(
        row(AgentCommissionStatus.CANCELLED),
      );
      await expect(
        service.adminCancel('agent-1', 'com-1', 'Faux placement', 'admin-1'),
      ).rejects.toThrow(ConflictException);
    });
  });

  it('never lists employer data', async () => {
    prisma.agentCommission.findMany.mockResolvedValue([
      {
        ...pending(),
        status: AgentCommissionStatus.PENDING,
        created_at: new Date(),
        released_at: null,
        cancelled_at: null,
        reason: null,
      },
    ]);
    prisma.agentCommission.count.mockResolvedValue(1);
    const { data } = await service.list('agent-1', { page: 1, limit: 20 });
    expect(data[0]).not.toHaveProperty('employer');
    expect(JSON.stringify(data[0])).not.toContain('e1');
  });
});
