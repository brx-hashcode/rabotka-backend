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
    ...overrides,
  };
}

function makeApplicationService(overrides = {}) {
  return {
    findByWorker: jest.fn().mockResolvedValue([]),
    findByJobOffer: jest.fn().mockResolvedValue([]),
    findByEmployer: jest.fn().mockResolvedValue([]),
    markAsViewed: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makePrisma(overrides = {}) {
  return {
    profile: { findUnique: jest.fn().mockResolvedValue(null) },
    jobOffer: { count: jest.fn().mockResolvedValue(0) },
    application: { count: jest.fn().mockResolvedValue(0) },
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
      { getProfileWalletBalance: jest.fn().mockResolvedValue(0) } as any,
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
      applicationService.findByWorker.mockResolvedValue([
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
      applicationService.findByEmployer = jest.fn().mockResolvedValue([
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
      jobOfferService.findByEmployerId.mockResolvedValue([mockOffer]);
      applicationService.findByJobOffer.mockResolvedValue([
        {
          id: 'app-1',
          status: 'PENDING',
          worker: {
            first_name: 'Alice',
            last_name: 'Dupont',
            reliability_score: 90,
            status: 'ACTIVE',
            email: 'alice@example.com',
            avatar_url: null,
            verification_status: 'VERIFIED',
          },
        },
      ]);
      const result = await service.candidaturesReceived(employerProfile);
      expect(result.applicationIds).toContain('app-1');
    });

    it('handles application with no worker (fullName = Inconnu)', async () => {
      jobOfferService.findByEmployerId.mockResolvedValue([mockOffer]);
      applicationService.findByJobOffer.mockResolvedValue([
        {
          id: 'app-2',
          status: 'PENDING',
          worker: null,
        },
      ]);
      const result = await service.candidaturesReceived(employerProfile);
      expect(result.applicationIds).toContain('app-2');
    });

    it('handles VIEWED status application', async () => {
      jobOfferService.findByEmployerId.mockResolvedValue([mockOffer]);
      applicationService.findByJobOffer.mockResolvedValue([
        {
          id: 'app-3',
          status: 'VIEWED',
          worker: {
            first_name: 'Bob',
            last_name: 'Smith',
            reliability_score: null,
            email: 'bob@test.com',
            avatar_url: 'http://example.com/avatar.jpg',
            verification_status: null,
          },
        },
      ]);
      const result = await service.candidaturesReceived(employerProfile);
      expect(result.applicationIds).toContain('app-3');
    });

    it('returns hasMore for more than 5 items', async () => {
      jobOfferService.findByEmployerId.mockResolvedValue([mockOffer]);
      applicationService.findByJobOffer.mockResolvedValue(
        Array.from({ length: 7 }, (_, i) => ({
          id: `app-${i}`,
          status: 'PENDING',
          worker: {
            first_name: `W${i}`,
            last_name: 'X',
            reliability_score: 80,
            email: `w${i}@test.com`,
            avatar_url: null,
            verification_status: 'VERIFIED',
          },
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
      jobOfferService.findByEmployerId.mockResolvedValue([
        { ...mockOffer, status: 'FILLED' },
      ]);
      applicationService.findByJobOffer.mockResolvedValue([
        {
          id: 'app-1',
          status: 'ACCEPTED',
          worker: { first_name: 'Alice', last_name: 'Dupont' },
        },
      ]);
      const result = await service.filledJobs(employerProfile);
      expect(result.items).toBeDefined();
    });

    it('skips accepted application with no worker', async () => {
      jobOfferService.findByEmployerId.mockResolvedValue([
        { ...mockOffer, status: 'FILLED' },
      ]);
      applicationService.findByJobOffer.mockResolvedValue([
        { id: 'app-1', status: 'ACCEPTED', worker: null },
      ]);
      const result = await service.filledJobs(employerProfile);
      expect(result.message).toContain('Aucune mission');
    });

    it('uses worker name with empty last_name as Inconnu', async () => {
      jobOfferService.findByEmployerId.mockResolvedValue([
        { ...mockOffer, status: 'FILLED' },
      ]);
      applicationService.findByJobOffer.mockResolvedValue([
        {
          id: 'app-1',
          status: 'ACCEPTED',
          worker: { first_name: '', last_name: '' },
        },
      ]);
      const result = await service.filledJobs(employerProfile);
      expect(result.items?.[0].workerName).toBe('Inconnu');
    });
  });

  describe('profile()', () => {
    it('returns not found message when profile missing', async () => {
      const result = await service.profile(workerProfile);
      expect(result).toContain('non trouvé');
    });

    it('returns worker profile stats', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        first_name: 'Alice',
        last_name: 'Dupont',
        email: 'alice@example.com',
        reliability_score: 90,
        status: 'ACTIVE',
        created_at: new Date(),
        avatar_url: null,
        profile_type: 'WORKER',
      });
      const result = await service.profile(workerProfile);
      expect(result).toBeDefined();
    });

    it('returns employer profile stats', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        first_name: 'Jean',
        last_name: 'Patron',
        email: 'jean@example.com',
        reliability_score: null,
        status: 'ACTIVE',
        created_at: new Date(),
        avatar_url: null,
        profile_type: 'EMPLOYER',
      });
      const result = await service.profile(employerProfile);
      expect(result).toBeDefined();
    });
  });

  describe('pendingPayments()', () => {
    it('returns empty message when no pending payments for worker', async () => {
      const result = await service.pendingPayments(workerProfile);
      expect(result.message).toContain('Aucun paiement');
    });

    it('returns pending payments list for worker', async () => {
      applicationService.findByWorker.mockResolvedValue([
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
      applicationService.findByEmployer = jest.fn().mockResolvedValue([]);
      const result = await service.pendingPayments(employerProfile);
      expect(result.message).toContain('Aucun paiement');
    });

    it('returns pending payments list for employer', async () => {
      applicationService.findByEmployer = jest.fn().mockResolvedValue([
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

  describe('profile() - avatar_url and EMPLOYER stats', () => {
    it('returns employer profile with avatar_url', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        first_name: 'Jean',
        last_name: 'Patron',
        email: 'jean@example.com',
        reliability_score: null,
        status: 'ACTIVE',
        created_at: new Date(),
        avatar_url: 'http://example.com/avatar.jpg',
        profile_type: 'EMPLOYER',
      });
      const result = await service.profile(employerProfile);
      expect(result).toContain('[IMG:');
    });

    it('returns worker profile with avatar_url', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        first_name: 'Alice',
        last_name: 'Dupont',
        email: 'alice@example.com',
        reliability_score: 85,
        status: 'ACTIVE',
        created_at: new Date(),
        avatar_url: 'http://example.com/avatar2.jpg',
        profile_type: 'WORKER',
      });
      applicationService.findByWorker.mockResolvedValue([
        {
          id: 'app-1',
          status: 'ACCEPTED',
          job_offer: {
            id: 'jo-1',
            title: 'Job',
            status: 'COMPLETED',
            amount: 15000,
          },
        },
      ]);
      const result = await service.profile(workerProfile);
      expect(result).toContain('[IMG:');
    });

    it('returns worker stats with completed applications', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        first_name: 'Alice',
        last_name: 'Dupont',
        email: 'alice@example.com',
        reliability_score: 90,
        status: 'ACTIVE',
        created_at: new Date(),
        avatar_url: null,
        profile_type: 'WORKER',
      });
      applicationService.findByWorker.mockResolvedValue([
        {
          id: 'app-1',
          status: 'ACCEPTED',
          job_offer: {
            id: 'jo-1',
            title: 'Job',
            status: 'COMPLETED',
            amount: 15000,
          },
        },
        {
          id: 'app-2',
          status: 'PENDING',
          job_offer: {
            id: 'jo-2',
            title: 'Job2',
            status: 'ACTIVE',
            amount: 10000,
          },
        },
      ]);
      const result = await service.profile(workerProfile);
      expect(result).toBeDefined();
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
      applicationService.findByWorker.mockResolvedValue([
        {
          id: 'app-1',
          status: 'ACCEPTED',
          job_offer: {
            id: 'jo-1',
            title: 'Job',
            status: 'COMPLETED',
            amount: 15000,
          },
        },
        {
          id: 'app-2',
          status: 'PENDING',
          job_offer: {
            id: 'jo-2',
            title: 'Job2',
            status: 'ACTIVE',
            amount: 10000,
          },
        },
      ]);
      const result = await service.penaltyHistory(workerProfile);
      expect(result).toBeDefined();
    });
  });

  describe('profile() - wallet error handling', () => {
    it('catches wallet error gracefully', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        first_name: 'Alice',
        last_name: 'Dupont',
        email: 'alice@example.com',
        reliability_score: 90,
        status: 'ACTIVE',
        created_at: new Date(),
        avatar_url: null,
        profile_type: 'WORKER',
      });
      // Create a new service with a wallet that throws
      const errorWallet = {
        getProfileWalletBalance: jest
          .fn()
          .mockRejectedValue(new Error('wallet error')),
      };
      const svc = new BotCommandsService(
        prisma as any,
        jobOfferService as any,
        applicationService as any,
        errorWallet as any,
        {
          getFees: jest
            .fn()
            .mockResolvedValue({ cancellationThresholdHours: 4 }),
        } as any,
      );
      const result = await svc.profile(workerProfile);
      expect(result).toBeDefined();
    });
  });
});
