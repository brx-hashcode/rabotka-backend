import { Test, TestingModule } from '@nestjs/testing';
import { InterestClusterService } from '../interest-cluster.service';
import { QdrantService } from '../../qdrant/qdrant.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { InterestSignalService } from '../interest-signal.service';

const mockQdrantClient = {
  retrieve: jest.fn().mockResolvedValue([]),
};

const mockQdrant = {
  ensureDenseCollection: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn().mockReturnValue(mockQdrantClient),
  embed: jest.fn().mockResolvedValue(Array.from({ length: 384 }, () => 0.1)),
  upsertDense: jest.fn().mockResolvedValue(undefined),
};

const mockPrisma = {
  profile: {
    findUnique: jest.fn().mockResolvedValue({
      description: 'Experienced plumber',
      status: 'ACTIVE',
      category: { name: 'Plomberie' },
      categories: [],
    }),
    count: jest.fn().mockResolvedValue(1),
  },
};

const mockSignals = {
  getRecentSignals: jest.fn().mockResolvedValue([]),
};

describe('InterestClusterService', () => {
  let service: InterestClusterService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InterestClusterService,
        { provide: QdrantService, useValue: mockQdrant },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: InterestSignalService, useValue: mockSignals },
      ],
    }).compile();
    service = module.get<InterestClusterService>(InterestClusterService);
  });

  it('onModuleInit ensures collection', async () => {
    await service.onModuleInit();
    expect(mockQdrant.ensureDenseCollection).toHaveBeenCalled();
  });

  it('getProfile returns null when no point found', async () => {
    mockQdrantClient.retrieve.mockResolvedValueOnce([]);
    const profile = await service.getProfile('user-1');
    expect(profile).toBeNull();
  });

  it('getProfile returns profile when point exists', async () => {
    const vector = Array.from({ length: 384 }, () => 0.1);
    mockQdrantClient.retrieve.mockResolvedValueOnce([
      {
        vector,
        payload: {
          positive_vectors: [vector],
          negative_vectors: [],
          categories: ['Plomberie'],
          seen_job_ids: ['job-1'],
          total_signals: 5,
        },
      },
    ]);
    const profile = await service.getProfile('user-1');
    expect(profile).not.toBeNull();
    expect(profile!.totalSignals).toBe(5);
    expect(profile!.categories).toContain('Plomberie');
  });

  it('ensureSeeded seeds when no vector exists yet', async () => {
    mockQdrantClient.retrieve.mockResolvedValue([]);
    await service.ensureSeeded('user-1');
    expect(mockQdrant.upsertDense).toHaveBeenCalled();
  });

  it('ensureSeeded does NOT overwrite a vector that has learned signals', async () => {
    // Regression: this ran from the KYC-verified hook and reset total_signals to
    // 0, so getting verified erased everything the user had taught the system.
    mockQdrantClient.retrieve.mockResolvedValue([
      {
        id: 'p1',
        vector: Array.from({ length: 384 }, () => 0.1),
        payload: { user_id: 'user-1', total_signals: 7 },
      },
    ]);

    await service.ensureSeeded('user-1');

    expect(mockQdrant.upsertDense).not.toHaveBeenCalled();
  });

  it('forceReseedFromProfile preserves the learned signal count', async () => {
    mockQdrantClient.retrieve.mockResolvedValue([
      {
        id: 'p1',
        vector: Array.from({ length: 384 }, () => 0.1),
        payload: { user_id: 'user-1', total_signals: 7 },
      },
    ]);

    await service.forceReseedFromProfile('user-1');

    expect(mockQdrant.upsertDense).toHaveBeenCalled();
    const payload = mockQdrant.upsertDense.mock.calls.at(-1)?.[3];
    expect(payload).toMatchObject({ total_signals: 0 });
  });

  it('applySignal creates new point when none exists (cold start)', async () => {
    mockQdrantClient.retrieve.mockResolvedValue([]);
    const vector = Array.from({ length: 384 }, () => 0.1);
    await service.applySignal('user-1', 'job-1', vector, 1.0, 'Plomberie');
    expect(mockQdrant.upsertDense).toHaveBeenCalled();
  });

  it('applySignal updates existing point with EMA', async () => {
    const existingVector = Array.from({ length: 384 }, () => 0.5);
    mockQdrantClient.retrieve.mockResolvedValueOnce([
      {
        vector: existingVector,
        payload: {
          user_id: 'user-1',
          total_signals: 3,
          seen_job_ids: ['job-old'],
          categories: ['Electricite'],
        },
      },
    ]);
    const jobVector = Array.from({ length: 384 }, () => 0.2);
    await service.applySignal('user-1', 'job-1', jobVector, 1.0, 'Plomberie');
    expect(mockQdrant.upsertDense).toHaveBeenCalled();
    const call = mockQdrant.upsertDense.mock.calls[0];
    expect(call[3]).toMatchObject({ total_signals: 4 });
  });
});
