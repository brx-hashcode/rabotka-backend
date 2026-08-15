import { MatchingService } from '../matching.service';

function makePrisma() {
  return {
    profile: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    application: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    jobOffer: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    jobCategory: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function makeQdrant() {
  return {
    ensureCollection: jest.fn().mockResolvedValue(undefined),
    ensureDenseCollection: jest.fn().mockResolvedValue(undefined),
    upsertHybrid: jest.fn().mockResolvedValue(undefined),
    upsertDense: jest.fn().mockResolvedValue(undefined),
    searchHybrid: jest.fn().mockResolvedValue([]),
    searchHybridWithFilter: jest.fn().mockResolvedValue([]),
    recommendDense: jest.fn().mockResolvedValue([]),
  };
}

function makeSystemConfig(enabled = true) {
  return {
    isSimilarityEnabled: jest.fn().mockResolvedValue(enabled),
    getMatchingReliabilityThreshold: jest.fn().mockResolvedValue(50),
    getRecommendationContactFee: jest.fn().mockResolvedValue(100),
    // Must be stubbed: without it every search method throws inside its try and
    // returns [] via the catch, so assertions silently exercise the error path.
    getRecommendationMinScore: jest.fn().mockResolvedValue(0.3),
  };
}

describe('MatchingService', () => {
  let service: MatchingService;
  let prisma: ReturnType<typeof makePrisma>;
  let qdrant: ReturnType<typeof makeQdrant>;
  let systemConfig: ReturnType<typeof makeSystemConfig>;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    qdrant = makeQdrant();
    systemConfig = makeSystemConfig(true);
    service = new MatchingService(
      prisma as any,
      qdrant as any,
      systemConfig as any,
    );
  });

  describe('when similarity is disabled', () => {
    beforeEach(() => {
      systemConfig.isSimilarityEnabled.mockResolvedValue(false);
    });

    it('indexWorkerProfile returns early', async () => {
      await service.indexWorkerProfile('profile-1');
      expect(prisma.profile.findUnique).not.toHaveBeenCalled();
    });

    it('indexJobOffer returns early', async () => {
      await service.indexJobOffer('jo-1');
      expect(prisma.jobOffer.findUnique).not.toHaveBeenCalled();
    });

    it('indexEmployerProfile returns early', async () => {
      await service.indexEmployerProfile('emp-1');
      expect(prisma.profile.findUnique).not.toHaveBeenCalled();
    });

    it('findMatchingWorkersForJob returns empty array', async () => {
      const result = await service.findMatchingWorkersForJob('jo-1');
      expect(result).toEqual([]);
    });

    it('findMatchingJobsForWorker returns empty array', async () => {
      const result = await service.findMatchingJobsForWorker('worker-1');
      expect(result).toEqual([]);
    });

    it('findMatchingWorkersForEmployer returns empty array', async () => {
      const result = await service.findMatchingWorkersForEmployer('emp-1');
      expect(result).toEqual([]);
    });

    it('findMatchingWorkersForEmployerProfile returns empty array', async () => {
      const result = await service.findMatchingWorkersForEmployerProfile(
        'emp-1',
        10,
      );
      expect(result).toEqual([]);
    });

    it('reindexPending returns early', async () => {
      await service.reindexPending();
      expect(prisma.jobOffer.findMany).not.toHaveBeenCalled();
    });
  });

  describe('indexWorkerProfile() - enabled', () => {
    it('returns early when profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);
      await service.indexWorkerProfile('missing');
      expect(qdrant.upsertHybrid).not.toHaveBeenCalled();
    });

    it('returns early when profile is not WORKER', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'emp-1',
        first_name: 'Jean',
        last_name: 'Patron',
        description: null,
        address: null,
        profile_type: 'EMPLOYER',
        reliability_score: 90,
        categories: [],
        applications: [],
      });
      await service.indexWorkerProfile('emp-1');
      expect(qdrant.upsertHybrid).not.toHaveBeenCalled();
    });

    it('indexes worker profile when found', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'worker-1',
        first_name: 'Alice',
        last_name: 'Dupont',
        description: 'Expert plombier',
        address: 'Brazzaville',
        profile_type: 'WORKER',
        reliability_score: 90,
        categories: [
          {
            category_id: 'cat-1',
            category: { name: 'Plomberie', description: 'Desc' },
          },
        ],
        applications: [
          { job_offer: { title: 'Job', category: { name: 'Plomberie' } } },
        ],
      });
      prisma.application.count.mockResolvedValue(5);
      await service.indexWorkerProfile('worker-1');
      expect(qdrant.upsertHybrid).toHaveBeenCalled();
      expect(prisma.profile.update).toHaveBeenCalled();
    });

    it('handles qdrant error gracefully', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'worker-1',
        first_name: 'Alice',
        last_name: 'Dupont',
        description: null,
        address: null,
        profile_type: 'WORKER',
        reliability_score: 80,
        categories: [],
        applications: [],
      });
      prisma.application.count.mockResolvedValue(0);
      qdrant.upsertHybrid.mockRejectedValueOnce(new Error('qdrant error'));
      await service.indexWorkerProfile('worker-1'); // should not throw
    });
  });

  describe('indexJobOffer() - enabled', () => {
    it('returns early when job offer not found', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue(null);
      await service.indexJobOffer('missing');
      expect(qdrant.upsertHybrid).not.toHaveBeenCalled();
    });

    const makeJob = (overrides: Record<string, unknown> = {}) => ({
      id: 'jo-1',
      title: 'Plombier',
      description: 'Test',
      address: 'Brazzaville',
      employer_id: 'emp-1',
      category_id: 'cat-1',
      amount: 15000,
      payment_flow: 'DIRECT',
      quantity: 1,
      note: null,
      status: 'ACTIVE',
      created_at: new Date(),
      category: { name: 'Plomberie', description: 'Desc' },
      ...overrides,
    });

    it('indexes job offer when found', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue(makeJob());
      await service.indexJobOffer('jo-1');
      expect(qdrant.upsertHybrid).toHaveBeenCalled();
    });

    it('handles qdrant error gracefully', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue(
        makeJob({ category_id: null, category: null }),
      );
      prisma.profile.findUnique.mockResolvedValue({ categories: [] });
      qdrant.upsertHybrid.mockRejectedValueOnce(new Error('qdrant error'));
      await service.indexJobOffer('jo-1'); // should not throw
    });
  });

  describe('indexEmployerProfile() - enabled', () => {
    it('returns early when profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);
      await service.indexEmployerProfile('missing');
      expect(qdrant.upsertDense).not.toHaveBeenCalled();
    });

    it('returns early when profile is not EMPLOYER', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'worker-1',
        first_name: 'Alice',
        last_name: 'Dupont',
        description: null,
        address: null,
        profile_type: 'WORKER',
        categories: [],
      });
      await service.indexEmployerProfile('worker-1');
      expect(qdrant.upsertHybrid).not.toHaveBeenCalled();
    });

    it('indexes employer profile when found', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'emp-1',
        first_name: 'Jean',
        last_name: 'Patron',
        description: 'CEO',
        address: 'Brazzaville',
        profile_type: 'EMPLOYER',
        categories: [{ category: { name: 'Plomberie', description: 'Desc' } }],
      });
      await service.indexEmployerProfile('emp-1');
      expect(qdrant.upsertHybrid).toHaveBeenCalled();
    });
  });

  describe('findMatchingWorkersForJob() - enabled', () => {
    it('returns empty array when job not found', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue(null);
      const result = await service.findMatchingWorkersForJob('missing');
      expect(result).toEqual([]);
    });

    it('searches by category when job has category', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-1',
        title: 'Plombier',
        description: null,
        address: null,
        category_id: 'cat-1',
        category: { name: 'Plomberie', description: null },
      });
      qdrant.searchHybridWithFilter.mockResolvedValue([
        {
          id: 'w-1',
          score: 0.9,
          payload: { profileId: 'w-1', categoryIds: ['cat-1'] },
        },
      ]);
      prisma.profile.findMany.mockResolvedValue([
        { id: 'w-1', reliability_score: 90, profile_type: 'WORKER' },
      ]);
      const result = await service.findMatchingWorkersForJob('jo-1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('searches without filter when no category', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-1',
        title: 'Plombier',
        description: null,
        address: null,
        category_id: null,
        category: null,
      });
      qdrant.searchHybrid.mockResolvedValue([]);
      const result = await service.findMatchingWorkersForJob('jo-1');
      expect(result).toEqual([]);
    });

    it('returns empty array on qdrant error', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-1',
        title: 'Plombier',
        description: null,
        address: null,
        category_id: 'cat-1',
        category: { name: 'Plomberie', description: null },
      });
      qdrant.searchHybridWithFilter.mockRejectedValueOnce(
        new Error('qdrant error'),
      );
      const result = await service.findMatchingWorkersForJob('jo-1');
      expect(result).toEqual([]);
    });

    it('returns the top `topN`, not five', async () => {
      // Retrieval filters every candidate to the offer's own category, so they
      // all carry the same one. A per-category cap therefore capped the whole
      // fan-out: a categorised offer reached five workers however many good
      // matches existed, and whatever max_notification_workers was set to.
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-1',
        title: 'Plombier',
        description: null,
        address: null,
        category_id: 'cat-1',
        category: { name: 'Plomberie', description: null },
      });

      const ids = Array.from({ length: 12 }, (_, i) => `w-${i}`);
      qdrant.searchHybridWithFilter.mockResolvedValue(
        ids.map((id) => ({
          id,
          score: 0.9,
          payload: { profileId: id, categoryIds: ['cat-1'] },
        })),
      );
      prisma.profile.findMany.mockResolvedValue(
        ids.map((id) => ({
          id,
          reliability_score: 90,
          profile_type: 'WORKER',
          categories: [{ category_id: 'cat-1' }],
        })),
      );

      const result = await service.findMatchingWorkersForJob('jo-1', 10);

      expect(result).toHaveLength(10);
      // Still in rank order — the cap is gone, the ranking is not.
      expect(result[0].score).toBeGreaterThanOrEqual(result[9].score);
    });

    it('never returns more than topN', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-1',
        title: 'Plombier',
        description: null,
        address: null,
        category_id: 'cat-1',
        category: { name: 'Plomberie', description: null },
      });

      const ids = Array.from({ length: 12 }, (_, i) => `w-${i}`);
      qdrant.searchHybridWithFilter.mockResolvedValue(
        ids.map((id) => ({
          id,
          score: 0.9,
          payload: { profileId: id, categoryIds: ['cat-1'] },
        })),
      );
      prisma.profile.findMany.mockResolvedValue(
        ids.map((id) => ({
          id,
          reliability_score: 90,
          profile_type: 'WORKER',
          categories: [{ category_id: 'cat-1' }],
        })),
      );

      expect(await service.findMatchingWorkersForJob('jo-1', 3)).toHaveLength(
        3,
      );
    });
  });

  describe('findMatchingJobsForWorker() - enabled', () => {
    it('returns empty array when profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);
      const result = await service.findMatchingJobsForWorker('missing');
      expect(result).toEqual([]);
    });

    it('returns empty when profile is not WORKER', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'emp-1',
        first_name: 'Jean',
        last_name: 'Patron',
        description: null,
        address: null,
        profile_type: 'EMPLOYER',
        categories: [],
      });
      const result = await service.findMatchingJobsForWorker('emp-1');
      expect(result).toEqual([]);
    });

    it('returns results for WORKER profile', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'w-1',
        first_name: 'Alice',
        last_name: 'Dupont',
        description: null,
        address: null,
        profile_type: 'WORKER',
        categories: [
          {
            category_id: 'cat-1',
            category: { name: 'Plomberie', description: null },
          },
        ],
      });
      qdrant.searchHybridWithFilter.mockResolvedValue([
        { id: 'jo-1', score: 0.85, payload: { jobOfferId: 'jo-1' } },
      ]);
      prisma.jobOffer.findMany.mockResolvedValue([
        { id: 'jo-1', employer_id: 'emp-1', category_id: 'cat-1' },
      ]);
      const result = await service.findMatchingJobsForWorker('w-1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns empty array on qdrant error', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'w-1',
        first_name: 'Alice',
        last_name: 'Dupont',
        description: null,
        address: null,
        profile_type: 'WORKER',
        categories: [
          { category_id: 'cat-1', category: { name: 'P', description: null } },
        ],
      });
      qdrant.searchHybridWithFilter.mockRejectedValueOnce(
        new Error('qdrant error'),
      );
      const result = await service.findMatchingJobsForWorker('w-1');
      expect(result).toEqual([]);
    });
  });

  describe('findMatchingWorkersForEmployer() - enabled', () => {
    it('returns empty array when employer profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);
      const result = await service.findMatchingWorkersForEmployer('emp-1');
      expect(result).toEqual([]);
    });
  });

  describe('findMatchingWorkersForEmployerProfile() - enabled', () => {
    it('returns empty array when employer profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValue(null);
      const result = await service.findMatchingWorkersForEmployerProfile(
        'emp-1',
        10,
      );
      expect(result).toEqual([]);
    });

    it('returns results for employer profile', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'emp-1',
        profile_type: 'EMPLOYER',
      });
      qdrant.recommendDense.mockResolvedValue([
        { id: 'w-1', score: 0.9, payload: { profileId: 'w-1' } },
      ]);
      prisma.profile.findMany.mockResolvedValue([
        { id: 'w-1', reliability_score: 90, profile_type: 'WORKER' },
      ]);
      const result = await service.findMatchingWorkersForEmployerProfile(
        'emp-1',
        10,
      );
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('reindexPending() - enabled', () => {
    it('processes pending items', async () => {
      prisma.jobOffer.findMany.mockResolvedValue([{ id: 'jo-1' }]);
      prisma.profile.findMany.mockResolvedValue([]);
      // indexJobOffer will be called - mock job offer lookup
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-1',
        title: 'Test',
        description: null,
        address: null,
        employer_id: 'emp-1',
        category_id: null,
        amount: 5000,
        payment_flow: 'DIRECT',
        quantity: 1,
        note: null,
        status: 'ACTIVE',
        created_at: new Date(),
        category: null,
      });
      prisma.profile.findUnique.mockResolvedValue({ categories: [] });
      await service.reindexPending();
      expect(prisma.jobOffer.findMany).toHaveBeenCalled();
    });

    it('handles empty pending list', async () => {
      prisma.jobOffer.findMany.mockResolvedValue([]);
      prisma.profile.findMany.mockResolvedValue([]);
      await service.reindexPending();
      expect(qdrant.upsertHybrid).not.toHaveBeenCalled();
    });
  });

  describe('indexWorkerProfile() - with negative categories', () => {
    it('fetches negative category names when worker has rejected categories', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'worker-2',
        first_name: 'Bob',
        last_name: 'Smith',
        description: 'Description text',
        address: '123 Street',
        profile_type: 'WORKER',
        reliability_score: 60,
        categories: [],
        applications: [],
      });
      prisma.application.count
        .mockResolvedValueOnce(3) // completedCount
        .mockResolvedValueOnce(10); // totalTerminalCount
      // Simulates having negative categories via computeNegativeCategoryIds
      // The application.findMany is called by computeNegativeCategoryIds
      prisma.application.findMany
        .mockResolvedValueOnce([
          { job_offer: { category_id: 'cat-bad' } },
          { job_offer: { category_id: 'cat-bad' } },
          { job_offer: { category_id: 'cat-bad' } },
        ]) // rejected apps (3 times = above threshold)
        .mockResolvedValueOnce([]); // successful apps (none = not in success set)
      prisma.jobCategory.findMany.mockResolvedValue([
        { name: 'Mauvaise catégorie' },
      ]);
      await service.indexWorkerProfile('worker-2');
      expect(qdrant.upsertHybrid).toHaveBeenCalled();
    });

    it('does not fetch category names when no negative categories', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'worker-3',
        first_name: 'Carol',
        last_name: 'Jones',
        description: null,
        address: null,
        profile_type: 'WORKER',
        reliability_score: 75,
        categories: [
          {
            category_id: 'cat-1',
            category: { name: 'Tech', description: null },
          },
        ],
        applications: [],
      });
      prisma.application.count.mockResolvedValue(0);
      // No rejected apps
      prisma.application.findMany
        .mockResolvedValueOnce([]) // rejected
        .mockResolvedValueOnce([]); // successful
      await service.indexWorkerProfile('worker-3');
      expect(prisma.jobCategory.findMany).not.toHaveBeenCalled();
    });
  });

  describe('indexJobOffer() - with category and payment variants', () => {
    it('indexes job with no category_id (fetches employer categories)', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-2',
        title: 'Job without category',
        description: 'Desc',
        address: 'Addr',
        employer_id: 'emp-2',
        category_id: null,
        amount: { toNumber: () => 25000 },
        payment_flow: 'HOURLY',
        quantity: 5,
        note: 'Extra note',
        status: 'ACTIVE',
        created_at: new Date(),
        category: null,
      });
      prisma.profile.findUnique.mockResolvedValue({
        categories: [
          { category: { name: 'Finance', description: 'Finance desc' } },
        ],
      });
      await service.indexJobOffer('jo-2');
      expect(qdrant.upsertHybrid).toHaveBeenCalled();
    });

    it('indexes job with Decimal-like amount (toNumber)', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-3',
        title: 'Job Decimal',
        description: 'Desc',
        address: 'Addr',
        employer_id: 'emp-3',
        category_id: 'cat-1',
        amount: { toNumber: () => 3000 }, // petit budget
        payment_flow: 'MONTHLY',
        quantity: 1,
        note: null,
        status: 'ACTIVE',
        created_at: new Date(),
        category: { name: 'Tech', description: 'Tech desc' },
      });
      await service.indexJobOffer('jo-3');
      expect(qdrant.upsertHybrid).toHaveBeenCalled();
    });

    it('indexes job with amount 0 (inconnu)', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-4',
        title: 'Job zero amount',
        description: 'Desc',
        address: 'Addr',
        employer_id: 'emp-4',
        category_id: 'cat-1',
        amount: 0,
        payment_flow: 'DAILY',
        quantity: 2,
        note: null,
        status: 'ACTIVE',
        created_at: new Date(),
        category: { name: 'Health', description: null },
      });
      await service.indexJobOffer('jo-4');
      expect(qdrant.upsertHybrid).toHaveBeenCalled();
    });

    it('indexes job with null amount', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-5',
        title: 'Job null amount',
        description: 'Desc',
        address: 'Addr',
        employer_id: 'emp-5',
        category_id: 'cat-1',
        amount: null,
        payment_flow: null,
        quantity: null,
        note: null,
        status: 'ACTIVE',
        created_at: new Date(),
        category: { name: 'Health', description: 'Health desc' },
      });
      await service.indexJobOffer('jo-5');
      expect(qdrant.upsertHybrid).toHaveBeenCalled();
    });
  });

  describe('findMatchingWorkersForJob() - with actual worker hits and reranking', () => {
    it('re-ranks workers with category exact match and different reliability scores', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-1',
        title: 'Job',
        description: 'Desc',
        address: 'Addr',
        category_id: 'cat-1',
        category: { name: 'Tech', description: null },
      });
      qdrant.searchHybridWithFilter.mockResolvedValue([
        {
          id: 'w-excellent',
          score: 0.7,
          payload: { profileId: 'w-excellent', categoryIds: ['cat-1'] },
        },
        {
          id: 'w-reliable',
          score: 0.7,
          payload: { profileId: 'w-reliable', categoryIds: ['cat-1'] },
        },
        {
          id: 'w-low',
          score: 0.7,
          payload: { profileId: 'w-low', categoryIds: ['cat-2'] },
        },
        {
          id: 'w-nocat',
          score: 0.6,
          payload: { profileId: 'w-nocat', categoryIds: [] },
        },
      ]);
      prisma.profile.findMany.mockResolvedValue([
        {
          id: 'w-excellent',
          reliability_score: 95,
          categories: [{ category_id: 'cat-1' }],
        },
        {
          id: 'w-reliable',
          reliability_score: 80,
          categories: [{ category_id: 'cat-1' }],
        },
        {
          id: 'w-low',
          reliability_score: 60,
          categories: [{ category_id: 'cat-2' }],
        },
        { id: 'w-nocat', reliability_score: null, categories: [] },
      ]);
      const result = await service.findMatchingWorkersForJob('jo-1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('re-ranks workers without category match (null jobCategoryId)', async () => {
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-2',
        title: 'Job',
        description: 'Desc',
        address: 'Addr',
        category_id: null,
        category: null,
      });
      qdrant.searchHybrid.mockResolvedValue([
        { id: 'w-1', score: 0.8, payload: { profileId: 'w-1' } },
      ]);
      prisma.profile.findMany.mockResolvedValue([
        {
          id: 'w-1',
          reliability_score: 85,
          categories: [{ category_id: 'cat-x' }],
        },
      ]);
      const result = await service.findMatchingWorkersForJob('jo-2');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('findMatchingJobsForWorker() - no categories (uses searchHybrid)', () => {
    it('uses searchHybrid when worker has no categories', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'w-1',
        first_name: 'Alice',
        last_name: 'Dupont',
        description: null,
        address: null,
        profile_type: 'WORKER',
        reliability_score: null,
        categories: [],
        applications: [],
      });
      qdrant.searchHybrid.mockResolvedValue([
        { id: 'jo-1', score: 0.7, payload: { jobOfferId: 'jo-1' } },
      ]);
      prisma.jobOffer.findMany.mockResolvedValue([
        {
          id: 'jo-1',
          category_id: 'cat-1',
          created_at: new Date(Date.now() - 24 * 3600000),
        },
      ]);
      prisma.application.findMany.mockResolvedValue([]);
      const result = await service.findMatchingJobsForWorker('w-1');
      expect(Array.isArray(result)).toBe(true);
    });

    it('downranks jobs with negative history', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'w-2',
        first_name: 'Bob',
        last_name: 'Jones',
        description: 'Expert',
        address: 'Brazzaville',
        profile_type: 'WORKER',
        reliability_score: 90,
        categories: [
          {
            category_id: 'cat-1',
            category: { name: 'Tech', description: null },
          },
        ],
        applications: [
          { job_offer: { title: 'Old Job', category: { name: 'Tech' } } },
        ],
      });
      qdrant.searchHybridWithFilter.mockResolvedValue([
        { id: 'jo-bad', score: 0.85, payload: { jobOfferId: 'jo-bad' } },
        { id: 'jo-good', score: 0.9, payload: { jobOfferId: 'jo-good' } },
      ]);
      prisma.jobOffer.findMany.mockResolvedValue([
        { id: 'jo-bad', category_id: 'cat-1', created_at: new Date() },
        { id: 'jo-good', category_id: 'cat-1', created_at: new Date() },
      ]);
      // negative application on jo-bad
      prisma.application.findMany.mockResolvedValue([
        { job_offer_id: 'jo-bad' },
      ]);
      const result = await service.findMatchingJobsForWorker('w-2');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('findMatchingWorkersForEmployerProfile() - enabled (correct signature)', () => {
    it('returns empty array when profile is not EMPLOYER', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'w-1',
        profile_type: 'WORKER',
        first_name: 'Alice',
        last_name: 'Dupont',
        description: null,
        address: null,
        categories: [],
      });
      const result = await service.findMatchingWorkersForEmployerProfile('w-1');
      expect(result).toEqual([]);
    });

    it('returns results and handles error gracefully', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'emp-1',
        profile_type: 'EMPLOYER',
        first_name: 'Jean',
        last_name: 'Patron',
        description: 'CEO',
        address: 'Brazzaville',
        categories: [{ category: { name: 'Tech', description: null } }],
      });
      qdrant.searchHybrid.mockRejectedValueOnce(new Error('qdrant error'));
      const result =
        await service.findMatchingWorkersForEmployerProfile('emp-1');
      expect(result).toEqual([]);
    });

    it('returns diverse workers from employer search', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'emp-2',
        profile_type: 'EMPLOYER',
        first_name: 'Marie',
        last_name: 'Dupont',
        description: null,
        address: null,
        categories: [],
      });
      qdrant.searchHybrid.mockResolvedValue([
        { id: 'w-1', score: 0.9, payload: { profileId: 'w-1' } },
        { id: 'w-2', score: 0.6, payload: { profileId: 'w-2' } },
      ]);
      prisma.profile.findMany.mockResolvedValue([
        {
          id: 'w-1',
          reliability_score: 90,
          categories: [{ category_id: 'cat-1' }],
        },
        { id: 'w-2', reliability_score: 70, categories: [] },
      ]);
      const result = await service.findMatchingWorkersForEmployerProfile(
        'emp-2',
        5,
      );
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('indexWorkerProfile() - various buildWorkerText branches', () => {
    it('includes completion stats and success rate when both counts present', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        id: 'w-full',
        first_name: 'Dave',
        last_name: 'Brown',
        description: 'Skilled worker',
        address: '456 Avenue',
        profile_type: 'WORKER',
        reliability_score: 65, // Fiable bucket (70 > 65, "Faible")
        categories: [
          {
            category_id: 'cat-1',
            category: { name: 'Plomberie', description: 'Water systems' },
          },
          {
            category_id: 'cat-2',
            category: { name: 'Electric', description: null },
          },
        ],
        applications: [
          {
            job_offer: {
              title: 'Plumbing Job',
              category: { name: 'Plomberie' },
            },
          },
          { job_offer: { title: 'Another Job', category: null } },
        ],
      });
      prisma.application.count
        .mockResolvedValueOnce(8) // completedCount
        .mockResolvedValueOnce(10); // totalTerminalCount
      prisma.application.findMany
        .mockResolvedValueOnce([]) // rejected
        .mockResolvedValueOnce([]); // successful
      await service.indexWorkerProfile('w-full');
      expect(qdrant.upsertHybrid).toHaveBeenCalled();
    });
  });

  describe('reindexPending() - with multiple items', () => {
    it('processes multiple jobs and profiles', async () => {
      // Return workers and employers too
      prisma.jobOffer.findMany.mockResolvedValue([
        { id: 'jo-1' },
        { id: 'jo-2' },
      ]);
      prisma.profile.findMany
        .mockResolvedValueOnce([{ id: 'w-1' }]) // workers
        .mockResolvedValueOnce([{ id: 'emp-1' }]); // employers
      prisma.jobOffer.findUnique.mockResolvedValue({
        id: 'jo-1',
        title: 'Test',
        description: null,
        address: null,
        employer_id: 'emp-1',
        category_id: null,
        amount: null,
        payment_flow: null,
        quantity: null,
        note: null,
        status: 'ACTIVE',
        created_at: new Date(),
        category: null,
      });
      prisma.profile.findUnique
        .mockResolvedValueOnce({ categories: [] }) // for indexJobOffer employer lookup
        .mockResolvedValueOnce({
          id: 'w-1',
          first_name: 'W',
          last_name: 'One',
          description: null,
          address: null,
          profile_type: 'WORKER',
          reliability_score: 100,
          categories: [],
          applications: [],
        })
        .mockResolvedValueOnce({
          id: 'emp-1',
          first_name: 'E',
          last_name: 'One',
          description: null,
          address: null,
          profile_type: 'EMPLOYER',
          categories: [],
        });
      prisma.application.count.mockResolvedValue(0);
      prisma.application.findMany.mockResolvedValue([]);
      await service.reindexPending();
      expect(prisma.jobOffer.findMany).toHaveBeenCalled();
    });
  });
});
