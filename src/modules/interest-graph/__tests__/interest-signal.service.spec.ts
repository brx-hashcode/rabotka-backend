import { Test, TestingModule } from '@nestjs/testing';
import {
  InterestSignalService,
  temporalWeight,
  SIGNAL_WEIGHTS,
} from '../interest-signal.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { QdrantService } from '../../qdrant/qdrant.service';
import { InterestClusterService } from '../interest-cluster.service';

const mockQdrantClient = {
  retrieve: jest.fn().mockResolvedValue([]),
  scroll: jest.fn().mockResolvedValue({ points: [] }),
};

const mockQdrant = {
  ensureDenseCollection: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn().mockReturnValue(mockQdrantClient),
  embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  upsertDense: jest.fn().mockResolvedValue(undefined),
};

const mockPrisma = {
  jobOffer: {
    findUnique: jest
      .fn()
      .mockResolvedValue({ title: 'Plumber', category: { name: 'Plomberie' } }),
  },
};

const mockClusters = {
  applySignal: jest.fn().mockResolvedValue(undefined),
};

describe('temporalWeight', () => {
  it('returns 1.0 for recent signal (< 30 days)', () => {
    const now = new Date();
    expect(temporalWeight(now)).toBe(1.0);
  });

  it('returns 0.7 for signal 31-60 days old', () => {
    const d = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    expect(temporalWeight(d)).toBe(0.7);
  });

  it('returns 0.4 for signal 61-90 days old', () => {
    const d = new Date(Date.now() - 70 * 24 * 60 * 60 * 1000);
    expect(temporalWeight(d)).toBe(0.4);
  });

  it('returns 0 for signal > 90 days old', () => {
    const d = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    expect(temporalWeight(d)).toBe(0);
  });
});

describe('SIGNAL_WEIGHTS', () => {
  it('has apply weight 1.0', () => {
    expect(SIGNAL_WEIGHTS.apply).toBe(1.0);
  });

  it('has skip as negative', () => {
    expect(SIGNAL_WEIGHTS.skip).toBeLessThan(0);
  });
});

describe('InterestSignalService', () => {
  let service: InterestSignalService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterestSignalService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: QdrantService, useValue: mockQdrant },
        { provide: InterestClusterService, useValue: mockClusters },
      ],
    }).compile();
    service = module.get<InterestSignalService>(InterestSignalService);
  });

  it('onModuleInit ensures collection', async () => {
    await service.onModuleInit();
    expect(mockQdrant.ensureDenseCollection).toHaveBeenCalled();
  });

  it('record with valid signal type upserts to qdrant', async () => {
    await service.record('user-1', 'job-1', 'apply');
    expect(mockQdrant.upsertDense).toHaveBeenCalled();
    expect(mockClusters.applySignal).toHaveBeenCalled();
  });

  it('record uses vector from jobs collection when available', async () => {
    mockQdrantClient.retrieve.mockResolvedValueOnce([
      { vector: { dense: [0.5, 0.6] } },
    ]);
    await service.record('user-1', 'job-1', 'save');
    expect(mockQdrant.upsertDense).toHaveBeenCalled();
    // embed should not be called if vector retrieved
    expect(mockQdrant.embed).not.toHaveBeenCalled();
  });

  it('record falls back to embed when no vector in qdrant', async () => {
    mockQdrantClient.retrieve.mockResolvedValueOnce([]);
    await service.record('user-1', 'job-1', 'view');
    expect(mockQdrant.embed).toHaveBeenCalled();
  });

  it('record is no-op when job not found', async () => {
    mockPrisma.jobOffer.findUnique.mockResolvedValueOnce(null);
    await service.record('user-1', 'unknown-job', 'apply');
    expect(mockQdrant.upsertDense).not.toHaveBeenCalled();
  });

  it('record handles cluster applySignal failure gracefully', async () => {
    mockClusters.applySignal.mockRejectedValueOnce(new Error('Cluster error'));
    await expect(
      service.record('user-1', 'job-1', 'apply'),
    ).resolves.not.toThrow();
  });

  it('record qdrant retrieve failure falls back to embed', async () => {
    mockQdrantClient.retrieve.mockRejectedValueOnce(new Error('Qdrant error'));
    await service.record('user-1', 'job-1', 'apply');
    expect(mockQdrant.embed).toHaveBeenCalled();
  });

  it('getRecentSignals returns filtered signals', async () => {
    const recentDate = new Date().toISOString();
    mockQdrantClient.scroll.mockResolvedValueOnce({
      points: [
        {
          payload: {
            job_id: 'job-1',
            type: 'apply',
            weight: 1.0,
            category: 'Plomberie',
            recorded_at: recentDate,
          },
        },
        {
          payload: {
            job_id: 'job-2',
            type: 'skip',
            weight: -0.3,
            category: null,
            recorded_at: new Date(
              Date.now() - 100 * 24 * 60 * 60 * 1000,
            ).toISOString(),
          },
        },
      ],
    });

    const result = await service.getRecentSignals('user-1');
    // The expired skip signal has temporal weight 0, effective = -0.3 * 0 = 0, so it's filtered out
    expect(result.some((s) => s.jobId === 'job-1')).toBe(true);
    expect(result.some((s) => s.jobId === 'job-2')).toBe(false);
  });
});
