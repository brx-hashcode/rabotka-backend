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
};

const employerProfile: BotProfile = { ...workerProfile, id: 'e-1', profile_type: 'EMPLOYER' };

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
    findActive: jest.fn().mockResolvedValue({ data: [mockOffer], nextCursor: null }),
    findById: jest.fn().mockResolvedValue(mockOffer),
    findByEmployerId: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeApplicationService(overrides = {}) {
  return {
    findByWorker: jest.fn().mockResolvedValue([]),
    findByJobOffer: jest.fn().mockResolvedValue([]),
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
    service = new BotCommandsService(prisma as any, jobOfferService as any, applicationService as any);
  });

  describe('listOffers()', () => {
    it('returns offer list message when offers exist', async () => {
      const result = await service.listOffers(workerProfile);
      expect(result.message).toBeDefined();
      expect(result.offerIds).toContain('offer-1');
    });

    it('returns no-offers message when empty', async () => {
      jobOfferService.findActive.mockResolvedValue({ data: [], nextCursor: null });
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

  describe('myOffers()', () => {
    it('blocks non-employer', async () => {
      const result = await service.myOffers(workerProfile);
      expect(result).toContain('EMPLOYEURS');
    });

    it('returns no-offers message when employer has none', async () => {
      const result = await service.myOffers(employerProfile);
      expect(result).toContain('AUCUNE OFFRE');
    });

    it('returns formatted offer list for employer', async () => {
      jobOfferService.findByEmployerId.mockResolvedValue([
        { ...mockOffer, amount: { toLocaleString: () => '15 000' } },
      ]);
      const result = await service.myOffers(employerProfile);
      expect(result).toContain('MES OFFRES');
    });
  });

  describe('candidaturesReceived()', () => {
    it('blocks non-employer', async () => {
      const result = await service.candidaturesReceived(workerProfile);
      expect(result.message).toContain('EMPLOYEURS');
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
            email: 'alice@example.com',
            avatar_url: null,
            verification_status: 'VERIFIED',
          },
        },
      ]);
      const result = await service.candidaturesReceived(employerProfile);
      expect(result.applicationIds).toContain('app-1');
    });
  });

  describe('filledJobs()', () => {
    it('blocks non-employer', async () => {
      const result = await service.filledJobs(workerProfile);
      expect(result.message).toContain('EMPLOYEURS');
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
        created_at: new Date(),
        avatar_url: null,
        profile_type: 'EMPLOYER',
      });
      const result = await service.profile(employerProfile);
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
  });
});
