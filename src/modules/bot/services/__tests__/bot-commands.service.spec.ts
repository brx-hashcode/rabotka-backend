import { BotCommandsService } from '../bot-commands.service';
import type { BotProfile } from '../../types/bot-state.types';

const workerProfile: BotProfile = {
  id: 'w-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  phone: '+242000001',
  email: 'alice@example.com',
  profile_type: 'WORKER',
  reliability_score: 90,
  status: 'ACTIVE',
};

const employerProfile: BotProfile = {
  ...workerProfile,
  id: 'e-1',
  profile_type: 'EMPLOYER',
};

const mockOffer = {
  id: 'offer-1',
  title: 'Plombier',
  description: 'Fix pipes',
  scheduled_at: new Date('2026-06-01T10:00:00Z'),
  amount: 15000,
  payment_flow: 'DAILY',
  address: '10 Rue Paris',
  note: null,
  quantity: 1,
  acceptedCount: 0,
  status: 'ACTIVE',
};

function makeJobOfferService(overrides = {}) {
  return {
    findActive: jest
      .fn()
      .mockResolvedValue({ data: [mockOffer], nextCursor: null }),
    findById: jest.fn().mockResolvedValue(mockOffer),
    findByEmployerId: jest
      .fn()
      .mockImplementation((_, opts) =>
        opts ? Promise.resolve({ items: [], total: 0 }) : Promise.resolve([]),
      ),
    getWorkerTopCategories: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/**
 * findByWorker / findByEmployer are overloaded: legacy `{limit}` returns
 * an array, new `{page, pageSize}` returns `{items, total}`. The default
 * mocks below return the right shape for each path; tests can override
 * with the array shape (legacy) and an adapter wraps it for paginated
 * calls.
 */
function emptyPaginated() {
  return Promise.resolve({ items: [], total: 0 });
}

function adaptToPaginated(rows: any[]) {
  return jest
    .fn()
    .mockImplementation((_id: string, opts?: { page?: number }) =>
      opts && opts.page !== undefined
        ? Promise.resolve({ items: rows, total: rows.length })
        : Promise.resolve(rows),
    );
}

function makeApplicationService(overrides: Record<string, unknown> = {}) {
  return {
    findByWorker: jest
      .fn()
      .mockImplementation((_id, opts) =>
        opts && (opts as { page?: number }).page !== undefined
          ? emptyPaginated()
          : Promise.resolve([]),
      ),
    findByJobOffer: jest.fn().mockResolvedValue([]),
    findByEmployer: jest
      .fn()
      .mockImplementation((_id, opts) =>
        opts && (opts as { page?: number }).page !== undefined
          ? emptyPaginated()
          : Promise.resolve([]),
      ),
    markAsViewed: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makePrisma(overrides = {}) {
  return {
    profile: { findUnique: jest.fn().mockResolvedValue(null) },
    jobOffer: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    application: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    penalty: { findMany: jest.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

describe('BotCommandsService', () => {
  let service: BotCommandsService;
  let jobOfferService: ReturnType<typeof makeJobOfferService>;
  let applicationService: ReturnType<typeof makeApplicationService>;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    jobOfferService = makeJobOfferService();
    applicationService = makeApplicationService();
    prisma = makePrisma();
    service = new BotCommandsService(
      prisma as any,
      jobOfferService as any,
      applicationService as any,
      {
        getFees: jest.fn().mockResolvedValue({ cancellationThresholdHours: 4 }),
      } as any,
    );
  });

  describe('listOffers()', () => {
    it('returns offer list message when offers exist', async () => {
      const result = await service.listOffers(workerProfile);
      expect(result.message).toBeDefined();
      expect(result.offerIds).toContain('offer-1');
    });

    it('returns no-offers message when empty', async () => {
      jobOfferService.findActive.mockResolvedValue({
        data: [],
        nextCursor: null,
      });
      const result = await service.listOffers(workerProfile);
      expect(result.message).toBeDefined();
      expect(result.offerIds).toBeUndefined();
    });

    it('passes nextCursor when more pages exist', async () => {
      jobOfferService.findActive.mockResolvedValue({
        data: [mockOffer],
        nextCursor: 'cursor-abc',
      });
      const result = await service.listOffers(workerProfile);
      expect(result.nextCursor).toBe('cursor-abc');
    });
  });

  describe('getOfferDetail()', () => {
    it('returns formatted detail string', async () => {
      const result = await service.getOfferDetail('offer-1');
      expect(result).toBeDefined();
      expect(result).toContain('Plombier');
    });

    it('returns null when offer not found', async () => {
      jobOfferService.findById.mockResolvedValue(null);
      const result = await service.getOfferDetail('missing');
      expect(result).toBeNull();
    });
  });

  describe('myApplications()', () => {
    it('returns empty message when no applications', async () => {
      const result = await service.myApplications(workerProfile);
      expect(result.message).toBeDefined();
    });

    it('returns application list with ids', async () => {
      applicationService.findByWorker = adaptToPaginated([
        {
          id: 'app-1',
          status: 'PENDING',
          job_offer: {
            id: 'jo-1',
            title: 'Plombier',
            scheduled_at: new Date(),
            amount: 15000,
            payment_flow: 'DAILY',
            address: '10 Rue Paris',
            status: 'ACTIVE',
          },
        },
      ]);
      const result = await service.myApplications(workerProfile);
      expect(result.applicationIds).toContain('app-1');
    });
  });

  describe('myApplications() - employer', () => {
    it('returns applications for employer profile', async () => {
      applicationService.findByEmployer = adaptToPaginated([
        {
          id: 'app-e1',
          status: 'PENDING',
          job_offer: {
            id: 'jo-e1',
            title: 'Electrician',
            scheduled_at: new Date(),
            amount: 20000,
            payment_flow: 'DAILY',
            address: 'Brazza',
            status: 'ACTIVE',
          },
        },
      ]);
      const result = await service.myApplications(employerProfile);
      expect(result.applicationIds).toContain('app-e1');
    });
  });

  describe('myOffers()', () => {
    it('blocks non-employer', async () => {
      const result = await service.myOffers(workerProfile);
      expect(result.message).toContain('employeurs');
    });

    it('returns no-offers message when employer has none', async () => {
      const result = await service.myOffers(employerProfile);
      expect(result.message).toContain('aucune offre');
    });

    it('returns formatted offer list for employer', async () => {
      jobOfferService.findByEmployerId.mockImplementation((_, opts) =>
        opts
          ? Promise.resolve({
              items: [
                { ...mockOffer, amount: { toLocaleString: () => '15 000' } },
              ],
              total: 1,
            })
          : Promise.resolve([mockOffer]),
      );
      const result = await service.myOffers(employerProfile);
      expect(result.message).toContain('Mes offres publiées');
      expect(result.offerIds).toHaveLength(1);
    });

    it('truncates long title (>40 chars)', async () => {
      const longTitle = 'A'.repeat(50);
      jobOfferService.findByEmployerId.mockImplementation((_, opts) =>
        opts
          ? Promise.resolve({
              items: [
                {
                  ...mockOffer,
                  title: longTitle,
                  amount: { toLocaleString: () => '15 000' },
                },
              ],
              total: 1,
            })
          : Promise.resolve([mockOffer]),
      );
      const result = await service.myOffers(employerProfile);
      expect(result.message).toContain('...');
    });

    it('shows "Prix à négocier" when amount is null', async () => {
      jobOfferService.findByEmployerId.mockImplementation((_, opts) =>
        opts
          ? Promise.resolve({
              items: [{ ...mockOffer, amount: null, scheduled_at: new Date() }],
              total: 1,
            })
          : Promise.resolve([]),
      );
      const result = await service.myOffers(employerProfile);
      expect(result.message).toContain('Prix à négocier');
    });

    it('shows page label and S- page suivante when hasMore', async () => {
      const items = Array.from({ length: 6 }, (_, i) => ({
        ...mockOffer,
        id: `offer-${i}`,
        amount: { toLocaleString: () => '15 000' },
        scheduled_at: new Date(),
      }));
      jobOfferService.findByEmployerId.mockImplementation((_, opts) =>
        opts
          ? Promise.resolve({ items: items.slice(0, 5), total: 6 })
          : Promise.resolve(items),
      );
      const result = await service.myOffers(employerProfile, 0);
      expect(result.message).toContain('S- Page suivante');
    });

    it('shows P- Page précédente when on page > 0', async () => {
      const items = Array.from({ length: 6 }, (_, i) => ({
        ...mockOffer,
        id: `offer-${i}`,
        amount: { toLocaleString: () => '15 000' },
        scheduled_at: new Date(),
      }));
      jobOfferService.findByEmployerId.mockImplementation((_, opts) =>
        opts
          ? Promise.resolve({ items: items.slice(5, 6), total: 6 })
          : Promise.resolve(items),
      );
      const result = await service.myOffers(employerProfile, 1);
      expect(result.message).toContain('P- Page précédente');
    });
  });

  describe('candidaturesReceived()', () => {
    it('blocks non-employer', async () => {
      const result = await service.candidaturesReceived(workerProfile);
      expect(result.message).toContain('employeurs');
    });

    it('returns no-pending message when no offers', async () => {
      const result = await service.candidaturesReceived(employerProfile);
      expect(result.message).toContain('Aucune candidature');
    });

    it('returns list with items when pending applications exist', async () => {
      prisma.application.findMany.mockResolvedValueOnce([
        {
          id: 'app-1',
          status: 'PENDING',
          worker_id: 'w-1',
          worker: {
            first_name: 'Alice',
            last_name: 'Dupont',
            reliability_score: 90,
            status: 'ACTIVE',
            email: 'alice@example.com',
            avatar_url: null,
            verification_status: 'VERIFIED',
          },
          job_offer: { title: 'Plombier' },
        },
      ]);
      const result = await service.candidaturesReceived(employerProfile);
      expect(result.applicationIds).toContain('app-1');
    });

    it('handles application with no worker (fullName = Inconnu)', async () => {
      prisma.application.findMany.mockResolvedValueOnce([
        { id: 'app-2', status: 'PENDING', worker_id: null, worker: null, job_offer: { title: 'Plombier' } },
      ]);
      const result = await service.candidaturesReceived(employerProfile);
      expect(result.applicationIds).toContain('app-2');
    });

    it('handles VIEWED status application', async () => {
      prisma.application.findMany.mockResolvedValueOnce([
        {
          id: 'app-3',
          status: 'VIEWED',
          worker_id: 'w-3',
          worker: {
            first_name: 'Bob',
            last_name: 'Smith',
            reliability_score: null,
            email: 'bob@test.com',
            avatar_url: 'http://example.com/avatar.jpg',
            verification_status: null,
          },
          job_offer: { title: 'Plombier' },
        },
      ]);
      const result = await service.candidaturesReceived(employerProfile);
      expect(result.applicationIds).toContain('app-3');
    });

    it('returns hasMore for more than 5 items', async () => {
      prisma.application.findMany.mockResolvedValueOnce(
        Array.from({ length: 7 }, (_, i) => ({
          id: `app-${i}`,
          status: 'PENDING',
          worker_id: `w-${i}`,
          worker: {
            first_name: `W${i}`,
            last_name: 'X',
            reliability_score: 80,
            email: `w${i}@test.com`,
            avatar_url: null,
            verification_status: 'VERIFIED',
          },
          job_offer: { title: 'Plombier' },
        })),
      );
      const result = await service.candidaturesReceived(employerProfile);
      expect(result.applicationIds?.length).toBeGreaterThan(5);
    });
  });

  describe('filledJobs()', () => {
    it('blocks non-employer', async () => {
      const result = await service.filledJobs(workerProfile);
      expect(result.message).toContain('employeurs');
    });

    it('returns no-filled message when no filled offers', async () => {
      const result = await service.filledJobs(employerProfile);
      expect(result.message).toContain('Aucune mission');
    });

    it('returns filled jobs list', async () => {
      prisma.application.findMany.mockResolvedValueOnce([
        {
          id: 'app-1',
          status: 'ACCEPTED',
          worker: { first_name: 'Alice', last_name: 'Dupont' },
          job_offer: { title: 'Plombier', scheduled_at: new Date(), amount: 15000, payment_flow: 'DAILY' },
        },
      ]);
      const result = await service.filledJobs(employerProfile);
      expect(result.items).toBeDefined();
    });

    it('skips accepted application with no worker', async () => {
      prisma.application.findMany.mockResolvedValueOnce([
        { id: 'app-1', status: 'ACCEPTED', worker: null, job_offer: { title: 'Plombier', scheduled_at: new Date(), amount: 15000, payment_flow: 'DAILY' } },
      ]);
      const result = await service.filledJobs(employerProfile);
      expect(result.message).toContain('Aucune mission');
    });

    it('uses worker name with empty last_name as Inconnu', async () => {
      prisma.application.findMany.mockResolvedValueOnce([
        {
          id: 'app-1',
          status: 'ACCEPTED',
          worker: { first_name: '', last_name: '' },
          job_offer: { title: 'Plombier', scheduled_at: new Date(), amount: 15000, payment_flow: 'DAILY' },
        },
      ]);
      const result = await service.filledJobs(employerProfile);
      expect(result.items?.[0].workerName).toBe('Inconnu');
    });
  });

  describe('pendingPayments()', () => {
    it('returns empty message when no pending payments for worker', async () => {
      const result = await service.pendingPayments(workerProfile);
      expect(result.message).toContain('Aucun paiement');
    });

    it('returns pending payments list for worker', async () => {
      applicationService.findByWorker = adaptToPaginated([
        {
          id: 'app-2',
          status: 'WAITING_PAYMENT',
          job_offer: {
            id: 'jo-2',
            title: 'Maçon',
            scheduled_at: new Date(),
            amount: 20000,
            payment_flow: 'DAILY',
            address: 'Pointe-Noire',
            status: 'ACTIVE',
          },
        },
      ]);
      const result = await service.pendingPayments(workerProfile);
      expect(result.applicationIds).toContain('app-2');
    });

    it('returns empty message when no pending payments for employer', async () => {
      applicationService.findByEmployer = adaptToPaginated([]);
      const result = await service.pendingPayments(employerProfile);
      expect(result.message).toContain('Aucun paiement');
    });

    it('returns pending payments list for employer', async () => {
      applicationService.findByEmployer = adaptToPaginated([
        {
          id: 'app-3',
          status: 'WAITING_PAYMENT',
          job_offer: {
            id: 'jo-3',
            title: 'Électricien',
            scheduled_at: new Date(),
            amount: 25000,
            payment_flow: 'HOURLY',
            address: 'Brazzaville',
            status: 'ACTIVE',
          },
        },
      ]);
      const result = await service.pendingPayments(employerProfile);
      expect(result.applicationIds).toContain('app-3');
    });
  });

  describe('penaltyHistory()', () => {
    it('returns formatted penalty history', async () => {
      const result = await service.penaltyHistory(workerProfile);
      expect(result).toBeDefined();
    });

    it('includes penalty items in history', async () => {
      prisma.penalty.findMany.mockResolvedValue([
        {
          id: 'pen-1',
          amount: 5000,
          reason: 'Late',
          applied_at: new Date(),
          application: { job_offer: { title: 'Plombier' } },
        },
      ]);
      const result = await service.penaltyHistory(workerProfile);
      expect(result).toBeDefined();
    });

    it('calculates completed stats from applications', async () => {
      prisma.application.findMany.mockResolvedValue([
        {
          job_offer: {
            title: 'Job',
            amount: 15000,
            scheduled_at: new Date('2026-05-01'),
          },
        },
      ]);
      prisma.application.count.mockResolvedValue(1);
      const result = await service.penaltyHistory(workerProfile);
      expect(result).toBeDefined();
    });
  });

});
