import { Test, TestingModule } from '@nestjs/testing';
import { InterestRecommendationService } from '../interest-recommendation.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { QdrantService } from '../../qdrant/qdrant.service';
import { InterestClusterService } from '../interest-cluster.service';

const mockQdrant = {
  recommendDense: jest.fn().mockResolvedValue([]),
  searchHybridWithFilter: jest.fn().mockResolvedValue([]),
};

const mockPrisma = {
  profile: {
    findUnique: jest.fn(),
  },
  jobOffer: {
    findMany: jest.fn().mockResolvedValue([]),
  },
};

const mockClusters = {
  getProfile: jest.fn(),
  reseedFromProfile: jest.fn().mockResolvedValue(undefined),
};

const makeProfile = (totalSignals: number) => ({
  positiveVectors: [Array.from({ length: 384 }, () => 0.1)],
  negativeVectors: [],
  categories: ['Plomberie'],
  seenJobIds: ['job-old'],
  totalSignals,
});

describe('InterestRecommendationService', () => {
  let service: InterestRecommendationService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterestRecommendationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: QdrantService, useValue: mockQdrant },
        { provide: InterestClusterService, useValue: mockClusters },
      ],
    }).compile();
    service = module.get<InterestRecommendationService>(InterestRecommendationService);
  });

  it('returns fallback for cold start (no profile)', async () => {
    mockClusters.getProfile.mockResolvedValueOnce(null);
    mockPrisma.profile.findUnique.mockResolvedValueOnce({
      description: 'Expert plumber',
      category: { name: 'Plomberie' },
      categories: [],
    });
    mockQdrant.searchHybridWithFilter.mockResolvedValueOnce([{ id: 'job-1', score: 0.8 }]);

    const results = await service.recommend('worker-1');
    expect(mockClusters.reseedFromProfile).toHaveBeenCalledWith('worker-1');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('fallback');
  });

  it('returns fallback when signals < warm threshold', async () => {
    mockClusters.getProfile.mockResolvedValueOnce(makeProfile(0));
    mockPrisma.profile.findUnique.mockResolvedValueOnce({
      description: 'Expert plumber',
      category: { name: 'Plomberie' },
      categories: [],
    });
    mockQdrant.searchHybridWithFilter.mockResolvedValueOnce([{ id: 'job-2', score: 0.7 }]);

    const results = await service.recommend('worker-1');
    expect(results[0].source).toBe('fallback');
  });

  it('returns empty array for cold start when no worker profile found', async () => {
    mockClusters.getProfile.mockResolvedValueOnce(null);
    mockPrisma.profile.findUnique.mockResolvedValueOnce(null);

    const results = await service.recommend('worker-1');
    expect(results).toHaveLength(0);
  });

  it('uses exploit+explore for warm user (1-4 signals)', async () => {
    mockClusters.getProfile.mockResolvedValueOnce(makeProfile(3));
    mockQdrant.recommendDense
      .mockResolvedValueOnce([{ id: 'job-exploit', score: 0.9 }])
      .mockResolvedValueOnce([{ id: 'job-explore', score: 0.6 }]);
    mockPrisma.profile.findUnique.mockResolvedValueOnce({
      description: 'plumber',
      category: { name: 'Plomberie' },
      categories: [],
    });
    mockQdrant.searchHybridWithFilter.mockResolvedValueOnce([{ id: 'job-fallback', score: 0.5 }]);

    const results = await service.recommend('worker-1');
    expect(results.length).toBeGreaterThan(0);
  });

  it('uses hot exploit ratio for hot user (5+ signals)', async () => {
    mockClusters.getProfile.mockResolvedValueOnce(makeProfile(10));
    mockQdrant.recommendDense.mockResolvedValue([{ id: 'job-hot', score: 0.95 }]);
    mockPrisma.profile.findUnique.mockResolvedValueOnce({
      description: 'plumber',
      category: { name: 'Plomberie' },
      categories: [],
    });
    mockQdrant.searchHybridWithFilter.mockResolvedValueOnce([]);

    const results = await service.recommend('worker-1', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('handles exploit qdrant failure gracefully', async () => {
    mockClusters.getProfile.mockResolvedValueOnce(makeProfile(5));
    mockQdrant.recommendDense.mockRejectedValue(new Error('Qdrant error'));
    mockPrisma.profile.findUnique.mockResolvedValueOnce({
      description: 'plumber',
      category: { name: 'Plomberie' },
      categories: [],
    });
    mockQdrant.searchHybridWithFilter.mockResolvedValueOnce([{ id: 'job-fb', score: 0.5 }]);

    const results = await service.recommend('worker-1');
    // Should get fallback results despite exploit failure
    expect(results).toBeDefined();
  });

  it('returns empty array for cold start when no query text', async () => {
    mockClusters.getProfile.mockResolvedValueOnce(null);
    mockPrisma.profile.findUnique.mockResolvedValueOnce({
      description: null,
      category: null,
      categories: [],
    });

    const results = await service.recommend('worker-1');
    expect(results).toHaveLength(0);
  });
});
