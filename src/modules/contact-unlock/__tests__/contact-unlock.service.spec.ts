import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ContactUnlockService } from '../contact-unlock.service';
import {
  ApplicationStatus,
  AssignmentStatus,
  BillingStatus,
  ContactUnlockStatus,
  JobOfferStatus,
  WalletTransactionType,
} from '@prisma/client';

jest.mock('../../penalty/penalty.utils', () => ({
  isWorkerHardBlocked: jest.fn().mockResolvedValue(false),
}));
import { isWorkerHardBlocked } from '../../penalty/penalty.utils';
const mockIsWorkerHardBlocked = isWorkerHardBlocked as jest.Mock;

function makePrisma() {
  const txMock = {
    application: { findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
    assignment: { updateMany: jest.fn() },
    jobOffer: { findUnique: jest.fn(), update: jest.fn() },
    contactUnlockAttempt: { update: jest.fn() },
  };

  return {
    contactUnlockAttempt: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    application: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    assignment: { updateMany: jest.fn() },
    jobOffer: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    profile: { findUnique: jest.fn() },
    paymentRequest: { create: jest.fn() },
    payment: { create: jest.fn() },
    $transaction: jest.fn().mockImplementation(async (cb) => cb(txMock)),
    _txMock: txMock,
  };
}

function makeWalletService() {
  return {
    debitProfileAndCreditSystem: jest.fn().mockResolvedValue(undefined),
    creditProfileWallet: jest.fn().mockResolvedValue(undefined),
    refundProfileWallet: jest.fn().mockResolvedValue(undefined),
  };
}

function makeInvoiceService() {
  return { create: jest.fn().mockResolvedValue({ id: 'inv-1' }) };
}

function makeMatchingService() {
  return { indexWorkerProfile: jest.fn().mockResolvedValue(undefined) };
}

function makeSystemConfig() {
  return {
    getContactUnlockFees: jest.fn().mockResolvedValue({
      employerFeeFcfa: 500,
      workerFeeFcfa: 100,
      expiryHours: 48,
    }),
  };
}

function makeAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: 'attempt-1',
    application_id: 'app-1',
    job_offer_id: 'jo-1',
    employer_id: 'emp-1',
    worker_id: 'worker-1',
    status: ContactUnlockStatus.PENDING_BOTH,
    employer_paid: false,
    worker_paid: false,
    employer_amount: 500,
    worker_amount: 100,
    expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
    ...overrides,
  };
}

describe('ContactUnlockService', () => {
  let service: ContactUnlockService;
  let prisma: ReturnType<typeof makePrisma>;
  let walletService: ReturnType<typeof makeWalletService>;
  let invoiceService: ReturnType<typeof makeInvoiceService>;
  let matchingService: ReturnType<typeof makeMatchingService>;
  let botNotification: { sendContactUnlockedNotification: jest.Mock };
  let interactionEvents: { record: jest.Mock; recordMany: jest.Mock };
  let systemConfig: ReturnType<typeof makeSystemConfig>;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    walletService = makeWalletService();
    invoiceService = makeInvoiceService();
    matchingService = makeMatchingService();
    systemConfig = makeSystemConfig();
    botNotification = { sendContactUnlockedNotification: jest.fn() };
    interactionEvents = { record: jest.fn(), recordMany: jest.fn() };
    service = new ContactUnlockService(
      prisma as any,
      systemConfig as any,
      walletService as any,
      invoiceService as any,
      matchingService as any,
      botNotification as any,
      interactionEvents as any,
    );
  });

  describe('initiateUnlock()', () => {
    it('returns existing attempt if one exists', async () => {
      const existing = makeAttempt();
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(existing);
      const result = await service.initiateUnlock('app-1', 'emp-1');
      expect(result).toBe(existing);
    });

    it('throws NotFoundException when app not found', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(null);
      prisma.application.findUnique.mockResolvedValue(null);
      await expect(service.initiateUnlock('app-1', 'emp-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when job offer not found', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(null);
      prisma.application.findUnique.mockResolvedValue({
        worker_id: 'w-1',
        job_offer_id: 'jo-1',
      });
      prisma.jobOffer.findUnique.mockResolvedValue(null);
      await expect(service.initiateUnlock('app-1', 'emp-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('creates a new attempt for single-person job', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(null);
      prisma.application.findUnique.mockResolvedValue({
        worker_id: 'w-1',
        job_offer_id: 'jo-1',
      });
      prisma.jobOffer.findUnique.mockResolvedValue({
        quantity: 1,
        employer_unlock_paid: false,
        scheduled_at: new Date(Date.now() + 100 * 60 * 60 * 1000),
      });
      prisma.contactUnlockAttempt.create.mockResolvedValue(makeAttempt());
      const result = await service.initiateUnlock('app-1', 'emp-1');
      expect(prisma.contactUnlockAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ContactUnlockStatus.PENDING_BOTH,
            employer_paid: false,
          }),
        }),
      );
      expect(result).toBeDefined();
    });

    it('creates attempt with employer_paid=true for multi-person job where employer already paid', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(null);
      prisma.application.findUnique.mockResolvedValue({
        worker_id: 'w-1',
        job_offer_id: 'jo-1',
      });
      prisma.jobOffer.findUnique.mockResolvedValue({
        quantity: 3,
        employer_unlock_paid: true,
        scheduled_at: new Date(Date.now() + 100 * 60 * 60 * 1000),
      });
      prisma.contactUnlockAttempt.create.mockResolvedValue(
        makeAttempt({
          employer_paid: true,
          status: ContactUnlockStatus.PENDING_WORKER,
        }),
      );
      await service.initiateUnlock('app-1', 'emp-1');
      expect(prisma.contactUnlockAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            employer_paid: true,
            status: ContactUnlockStatus.PENDING_WORKER,
          }),
        }),
      );
    });

    it('uses twoHBeforeJob expiry when scheduled_at is soon', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(null);
      prisma.application.findUnique.mockResolvedValue({
        worker_id: 'w-1',
        job_offer_id: 'jo-1',
      });
      // scheduled_at = 3 hours from now (2h before = 1h from now < 48h configWindow)
      prisma.jobOffer.findUnique.mockResolvedValue({
        quantity: 1,
        employer_unlock_paid: false,
        scheduled_at: new Date(Date.now() + 3 * 60 * 60 * 1000),
      });
      prisma.contactUnlockAttempt.create.mockResolvedValue(makeAttempt());
      await service.initiateUnlock('app-1', 'emp-1');
      expect(prisma.contactUnlockAttempt.create).toHaveBeenCalled();
    });
  });

  describe('payUnlock()', () => {
    it('throws NotFoundException when attempt not found', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(null);
      await expect(
        service.payUnlock('attempt-1', 'emp-1', false),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns early exit when already UNLOCKED', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({ status: ContactUnlockStatus.UNLOCKED }),
      );
      const result = await service.payUnlock('attempt-1', 'emp-1', false);
      expect(result.status).toBe(ContactUnlockStatus.UNLOCKED);
      expect(result.newlyUnlocked).toEqual([]);
    });

    it('throws BadRequestException when attempt is EXPIRED', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({ status: ContactUnlockStatus.EXPIRED }),
      );
      await expect(
        service.payUnlock('attempt-1', 'emp-1', false),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when attempt is CONVERTED_TO_CREDIT', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({ status: ContactUnlockStatus.CONVERTED_TO_CREDIT }),
      );
      await expect(
        service.payUnlock('attempt-1', 'emp-1', false),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException when not a participant', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(makeAttempt());
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.CLEAR,
      });
      await expect(
        service.payUnlock('attempt-1', 'stranger', false),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when billing is BLOCKED', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(makeAttempt());
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.BLOCKED,
      });
      await expect(
        service.payUnlock('attempt-1', 'emp-1', false),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when hard blocked', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(makeAttempt());
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.CLEAR,
      });
      mockIsWorkerHardBlocked.mockResolvedValueOnce(true);
      await expect(
        service.payUnlock('attempt-1', 'emp-1', false),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when employer already paid', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({ employer_paid: true }),
      );
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.CLEAR,
      });
      await expect(
        service.payUnlock('attempt-1', 'emp-1', false),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when worker already paid', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({ worker_paid: true }),
      );
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.CLEAR,
      });
      await expect(
        service.payUnlock('attempt-1', 'worker-1', false),
      ).rejects.toThrow(BadRequestException);
    });

    it('employer pays with credit for single-person job', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(makeAttempt());
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.CLEAR,
      });
      prisma.jobOffer.findUnique.mockResolvedValue({
        quantity: 1,
        employer_unlock_paid: false,
      });
      prisma.contactUnlockAttempt.updateMany.mockResolvedValue({ count: 1 });
      prisma.contactUnlockAttempt.findUniqueOrThrow.mockResolvedValue(
        makeAttempt({
          employer_paid: true,
          status: ContactUnlockStatus.PENDING_WORKER,
        }),
      );
      prisma.paymentRequest.create.mockResolvedValue({ id: 'pr-1' });
      prisma.payment.create.mockResolvedValue({ id: 'pay-1' });
      const result = await service.payUnlock('attempt-1', 'emp-1', true);
      expect(walletService.debitProfileAndCreditSystem).toHaveBeenCalled();
      expect(result.status).toBe(ContactUnlockStatus.PENDING_WORKER);
    });

    it('both parties pay → UNLOCKED status', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({
          worker_paid: true,
          status: ContactUnlockStatus.PENDING_EMPLOYER,
        }),
      );
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.CLEAR,
      });
      prisma.jobOffer.findUnique.mockResolvedValue({
        quantity: 1,
        employer_unlock_paid: false,
      });
      prisma.contactUnlockAttempt.updateMany.mockResolvedValue({ count: 1 });
      const unlockedAttempt = makeAttempt({
        employer_paid: true,
        worker_paid: true,
        status: ContactUnlockStatus.UNLOCKED,
      });
      prisma.contactUnlockAttempt.findUniqueOrThrow.mockResolvedValue(
        unlockedAttempt,
      );
      prisma.application.findMany.mockResolvedValue([
        { worker_id: 'worker-1' },
      ]);
      prisma.application.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.payUnlock('attempt-1', 'emp-1', false);
      expect(result.status).toBe(ContactUnlockStatus.UNLOCKED);
      expect(result.newlyUnlocked).toContain('attempt-1');
    });

    it('records the unlock for BOTH parties — the strongest intent signal', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({
          worker_paid: true,
          status: ContactUnlockStatus.PENDING_EMPLOYER,
        }),
      );
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.CLEAR,
      });
      prisma.jobOffer.findUnique.mockResolvedValue({
        quantity: 1,
        employer_unlock_paid: false,
      });
      prisma.contactUnlockAttempt.updateMany.mockResolvedValue({ count: 1 });
      prisma.contactUnlockAttempt.findUniqueOrThrow.mockResolvedValue(
        makeAttempt({
          employer_paid: true,
          worker_paid: true,
          status: ContactUnlockStatus.UNLOCKED,
        }),
      );
      prisma.application.findMany.mockResolvedValue([
        { worker_id: 'worker-1' },
      ]);
      prisma.application.updateMany.mockResolvedValue({ count: 1 });

      await service.payUnlock('attempt-1', 'emp-1', false);

      // Until this existed, only the recommendation flow emitted CONTACT_PAID.
      // The application-based unlock — used by the web app AND the WhatsApp bot
      // — recorded nothing, so the interest graph saw one of two purchase paths.
      // Both directions, as job completion already does: the employer learns
      // about this worker, the worker learns about this kind of job.
      const kinds = interactionEvents.record.mock.calls.map(
        (c: [{ kind: string; actorType: string }]) => [
          c[0].actorType,
          c[0].kind,
        ],
      );

      expect(kinds).toEqual(
        expect.arrayContaining([
          ['EMPLOYER', 'CONTACT_PAID'],
          ['WORKER', 'CONTACT_PAID'],
        ]),
      );
    });

    it('throws when concurrent payment guard fails (count=0)', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(makeAttempt());
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.CLEAR,
      });
      prisma.jobOffer.findUnique.mockResolvedValue({ quantity: 1 });
      prisma.contactUnlockAttempt.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.payUnlock('attempt-1', 'emp-1', false),
      ).rejects.toThrow(BadRequestException);
    });

    it('employer pays multi-person job', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(makeAttempt());
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.CLEAR,
      });
      prisma.jobOffer.findUnique.mockResolvedValue({
        quantity: 3,
        employer_unlock_paid: false,
      });
      prisma.jobOffer.update.mockResolvedValue({});
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([]);
      const result = await service.payUnlock('attempt-1', 'emp-1', false);
      expect(prisma.jobOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ employer_unlock_paid: true }),
        }),
      );
      expect(result.attemptId).toBe('attempt-1');
    });

    it('employer pays multi-person: cascades UNLOCKED when worker already paid', async () => {
      const attempt = makeAttempt({ worker_paid: true });
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(attempt);
      prisma.profile.findUnique.mockResolvedValue({
        billing_status: BillingStatus.CLEAR,
      });
      prisma.jobOffer.findUnique.mockResolvedValue({
        quantity: 3,
        employer_unlock_paid: false,
      });
      prisma.jobOffer.update.mockResolvedValue({});
      // pendingAttempts includes a worker_paid=true attempt
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([
        makeAttempt({ id: 'attempt-2', worker_paid: true }),
      ]);
      prisma.contactUnlockAttempt.update.mockResolvedValue({});
      prisma.contactUnlockAttempt.findUnique
        .mockResolvedValueOnce(attempt)
        .mockResolvedValueOnce({ application_id: 'app-trigger' });
      prisma.application.findMany.mockResolvedValue([{ worker_id: 'w-1' }]);
      prisma.application.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.payUnlock('attempt-1', 'emp-1', false);
      expect(result.newlyUnlocked.length).toBeGreaterThan(0);
    });
  });

  describe('rejectPendingAttemptByApplication()', () => {
    const fullAttempt = {
      ...makeAttempt({ status: ContactUnlockStatus.PENDING_BOTH }),
      worker: {
        id: 'worker-1',
        phone: '+242001',
        first_name: 'Bob',
        last_name: 'Jones',
      },
      employer: {
        id: 'emp-1',
        phone: '+242002',
        first_name: 'Jean',
        last_name: 'Patron',
      },
      job_offer: {
        id: 'jo-1',
        title: 'Plombier',
        quantity: 1,
        status: JobOfferStatus.ACTIVE,
        scheduled_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
      },
    };

    it('throws NotFoundException when attempt not found', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(null);
      await expect(
        service.rejectPendingAttemptByApplication('app-1', 'emp-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not a participant', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(fullAttempt);
      await expect(
        service.rejectPendingAttemptByApplication('app-1', 'stranger'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when attempt is UNLOCKED', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue({
        ...fullAttempt,
        status: ContactUnlockStatus.UNLOCKED,
      });
      await expect(
        service.rejectPendingAttemptByApplication('app-1', 'emp-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects by employer and refunds worker', async () => {
      const attempt = {
        ...fullAttempt,
        employer_paid: false,
        worker_paid: true,
      };
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(attempt);
      const txMock = prisma._txMock;
      txMock.application.count.mockResolvedValue(0);
      txMock.jobOffer.findUnique.mockResolvedValue({
        status: JobOfferStatus.ACTIVE,
        scheduled_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });
      txMock.contactUnlockAttempt.update.mockResolvedValue({});
      txMock.application.update.mockResolvedValue({});
      txMock.assignment.updateMany.mockResolvedValue({ count: 1 });
      txMock.jobOffer.update.mockResolvedValue({});
      const result = await service.rejectPendingAttemptByApplication(
        'app-1',
        'emp-1',
      );
      expect(walletService.refundProfileWallet).toHaveBeenCalled(); // worker refunded
      expect(result.otherPhone).toBe('+242001'); // worker phone
    });

    it('rejects by worker and refunds employer', async () => {
      const attempt = {
        ...fullAttempt,
        employer_paid: true,
        worker_paid: false,
      };
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(attempt);
      const txMock = prisma._txMock;
      txMock.application.count.mockResolvedValue(0);
      txMock.jobOffer.findUnique.mockResolvedValue({
        status: JobOfferStatus.ACTIVE,
        scheduled_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });
      txMock.contactUnlockAttempt.update.mockResolvedValue({});
      txMock.application.update.mockResolvedValue({});
      txMock.assignment.updateMany.mockResolvedValue({ count: 1 });
      txMock.jobOffer.update.mockResolvedValue({});
      const result = await service.rejectPendingAttemptByApplication(
        'app-1',
        'worker-1',
      );
      expect(walletService.refundProfileWallet).toHaveBeenCalled(); // employer refunded
      expect(result.otherPhone).toBe('+242002'); // employer phone
    });

    it('no refund when neither party has paid', async () => {
      const attempt = {
        ...fullAttempt,
        employer_paid: false,
        worker_paid: false,
      };
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(attempt);
      const txMock = prisma._txMock;
      txMock.application.count.mockResolvedValue(0);
      txMock.jobOffer.findUnique.mockResolvedValue({
        status: JobOfferStatus.ACTIVE,
        scheduled_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });
      txMock.contactUnlockAttempt.update.mockResolvedValue({});
      txMock.application.update.mockResolvedValue({});
      txMock.assignment.updateMany.mockResolvedValue({ count: 1 });
      txMock.jobOffer.update.mockResolvedValue({});
      await service.rejectPendingAttemptByApplication('app-1', 'emp-1');
      expect(walletService.refundProfileWallet).not.toHaveBeenCalled();
    });
  });

  describe('getContactsIfUnlocked()', () => {
    it('returns null when attempt not found', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(null);
      const result = await service.getContactsIfUnlocked('attempt-1', 'emp-1');
      expect(result).toBeNull();
    });

    it('returns null when attempt not UNLOCKED', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({ status: ContactUnlockStatus.PENDING_BOTH }),
      );
      const result = await service.getContactsIfUnlocked('attempt-1', 'emp-1');
      expect(result).toBeNull();
    });

    it('returns null when requester is not a participant', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({ status: ContactUnlockStatus.UNLOCKED }),
      );
      const result = await service.getContactsIfUnlocked(
        'attempt-1',
        'stranger',
      );
      expect(result).toBeNull();
    });

    it('returns null when other party profile not found', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({ status: ContactUnlockStatus.UNLOCKED }),
      );
      prisma.profile.findUnique.mockResolvedValue(null);
      const result = await service.getContactsIfUnlocked('attempt-1', 'emp-1');
      expect(result).toBeNull();
    });

    it('returns contact details for employer requesting', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({ status: ContactUnlockStatus.UNLOCKED }),
      );
      prisma.profile.findUnique.mockResolvedValue({
        first_name: 'Bob',
        last_name: 'Jones',
        phone: '+242001',
        email: 'bob@test.com',
      });
      const result = await service.getContactsIfUnlocked('attempt-1', 'emp-1');
      expect(result).toMatchObject({ name: 'Bob Jones', phone: '+242001' });
    });

    it('returns contact details for worker requesting', async () => {
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(
        makeAttempt({ status: ContactUnlockStatus.UNLOCKED }),
      );
      prisma.profile.findUnique.mockResolvedValue({
        first_name: 'Jean',
        last_name: 'Patron',
        phone: '+242002',
        email: 'jean@test.com',
      });
      const result = await service.getContactsIfUnlocked(
        'attempt-1',
        'worker-1',
      );
      expect(result).toMatchObject({ name: 'Jean Patron' });
    });
  });

  describe('findPendingAttemptForProfile()', () => {
    it('delegates to prisma and returns result', async () => {
      const attempt = makeAttempt();
      prisma.contactUnlockAttempt.findFirst.mockResolvedValue(attempt);
      const result = await service.findPendingAttemptForProfile('emp-1');
      expect(result).toBe(attempt);
    });
  });

  describe('getByApplicationId()', () => {
    it('returns attempt by application id', async () => {
      const attempt = makeAttempt();
      prisma.contactUnlockAttempt.findUnique.mockResolvedValue(attempt);
      const result = await service.getByApplicationId('app-1');
      expect(result).toBe(attempt);
    });
  });

  describe('processExpiredAttempts()', () => {
    it('returns empty array when no expired attempts', async () => {
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([]);
      const result = await service.processExpiredAttempts();
      expect(result).toEqual([]);
    });

    it('converts worker-paid, employer-not-paid to credit', async () => {
      const attempt = {
        ...makeAttempt({ employer_paid: false, worker_paid: true }),
        job_offer: { quantity: 1, employer_unlock_paid: false },
      };
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([attempt]);
      prisma.contactUnlockAttempt.update.mockResolvedValue({});
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma._txMock));
      prisma._txMock.application.findUnique.mockResolvedValue({
        status: 'WAITING_PAYMENT',
      });
      prisma._txMock.jobOffer.findUnique.mockResolvedValue({
        status: JobOfferStatus.ACTIVE,
        scheduled_at: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });
      prisma._txMock.application.update.mockResolvedValue({});
      prisma._txMock.assignment.updateMany.mockResolvedValue({ count: 1 });
      prisma._txMock.application.count.mockResolvedValue(0);
      prisma._txMock.jobOffer.update.mockResolvedValue({});
      const result = await service.processExpiredAttempts();
      expect(walletService.refundProfileWallet).toHaveBeenCalledWith(
        'worker-1',
        100,
        WalletTransactionType.CONTACT_UNLOCK_CREDIT_CONVERSION,
        'contact_unlock_attempt',
        'attempt-1',
      );
      expect(result).toHaveLength(1);
      expect(result[0].profileId).toBe('worker-1');
    });

    it('converts employer-paid, worker-not-paid to credit', async () => {
      const attempt = {
        ...makeAttempt({ employer_paid: true, worker_paid: false }),
        job_offer: { quantity: 1, employer_unlock_paid: false },
      };
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([attempt]);
      prisma.contactUnlockAttempt.update.mockResolvedValue({});
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma._txMock));
      prisma._txMock.application.findUnique.mockResolvedValue(null);
      const result = await service.processExpiredAttempts();
      expect(walletService.refundProfileWallet).toHaveBeenCalledWith(
        'emp-1',
        500,
        WalletTransactionType.CONTACT_UNLOCK_CREDIT_CONVERSION,
        'contact_unlock_attempt',
        'attempt-1',
      );
      expect(result[0].profileId).toBe('emp-1');
    });

    it('marks as EXPIRED when neither party paid', async () => {
      const attempt = {
        ...makeAttempt({ employer_paid: false, worker_paid: false }),
        job_offer: { quantity: 1, employer_unlock_paid: false },
      };
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([attempt]);
      prisma.contactUnlockAttempt.update.mockResolvedValue({});
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma._txMock));
      prisma._txMock.application.findUnique.mockResolvedValue(null);
      const result = await service.processExpiredAttempts();
      expect(walletService.refundProfileWallet).not.toHaveBeenCalled();
      expect(result).toHaveLength(0);
      expect(prisma.contactUnlockAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ContactUnlockStatus.EXPIRED,
          }),
        }),
      );
    });

    it('multi-person job: refunds worker only when employer paid at job level', async () => {
      const attempt = {
        ...makeAttempt({ employer_paid: true, worker_paid: true }),
        job_offer: { quantity: 3, employer_unlock_paid: true },
      };
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([attempt]);
      prisma.contactUnlockAttempt.update.mockResolvedValue({});
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma._txMock));
      prisma._txMock.application.findUnique.mockResolvedValue(null);
      const result = await service.processExpiredAttempts();
      expect(walletService.refundProfileWallet).toHaveBeenCalledWith(
        'worker-1',
        expect.any(Number),
        expect.any(String),
        expect.any(String),
        expect.any(String),
      );
      expect(result[0].profileId).toBe('worker-1');
    });

    it('swallows errors for individual attempts', async () => {
      const attempt = {
        ...makeAttempt(),
        job_offer: { quantity: 1, employer_unlock_paid: false },
      };
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([attempt]);
      walletService.creditProfileWallet.mockRejectedValueOnce(
        new Error('wallet fail'),
      );
      prisma.contactUnlockAttempt.update.mockResolvedValue({});
      prisma.$transaction.mockImplementation(async (cb) => cb(prisma._txMock));
      prisma._txMock.application.findUnique.mockResolvedValue(null);
      // Should not throw
      const result = await service.processExpiredAttempts();
      expect(result).toEqual([]);
    });
  });

  describe('expirePendingAttemptsForJob()', () => {
    it('updates expiry and calls processExpiredAttempts', async () => {
      prisma.contactUnlockAttempt.updateMany.mockResolvedValue({ count: 2 });
      prisma.contactUnlockAttempt.findMany.mockResolvedValue([]);
      await service.expirePendingAttemptsForJob('jo-1');
      expect(prisma.contactUnlockAttempt.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ job_offer_id: 'jo-1' }),
        }),
      );
    });
  });
});
