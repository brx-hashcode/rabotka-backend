import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { QdrantService } from '../qdrant.service';
import { QDRANT_COLLECTION_PREFIX } from '../qdrant.config';

const validCollection = `${QDRANT_COLLECTION_PREFIX}test-collection`;

const mockClient = {
  getCollections: jest.fn(),
  createCollection: jest.fn().mockResolvedValue(undefined),
  upsert: jest.fn().mockResolvedValue(undefined),
  query: jest.fn(),
};

// Mock the QdrantClient constructor
jest.mock('@qdrant/js-client-rest', () => {
  return {
    QdrantClient: jest.fn().mockImplementation(() => mockClient),
  };
});

// Mock fastembed - use jest.fn() stubs that will be configured later
jest.mock('fastembed', () => {
  const makeDenseGen = () =>
    (async function* () {
      yield [new Float32Array(384).fill(0.1)];
    })();
  const makeSparseGen = () =>
    (async function* () {
      yield [
        {
          indices: new Int32Array([0, 1]),
          values: new Float32Array([0.5, 0.3]),
        },
      ];
    })();
  const denseEmbedder = { embed: jest.fn().mockReturnValue(makeDenseGen()) };
  const sparseEmbedder = { embed: jest.fn().mockReturnValue(makeSparseGen()) };
  return {
    EmbeddingModel: { BGESmallENV15: 'BAAI/bge-small-en-v1.5' },
    SparseEmbeddingModel: { SpladePPEnV1: 'prithivida/Splade_PP_en_v1' },
    FlagEmbedding: { init: jest.fn().mockResolvedValue(denseEmbedder) },
    SparseTextEmbedding: { init: jest.fn().mockResolvedValue(sparseEmbedder) },
    _denseEmbedder: denseEmbedder,
    _sparseEmbedder: sparseEmbedder,
  };
});

import * as fastembedMock from 'fastembed';
const mockDenseEmbedder = (fastembedMock as any)._denseEmbedder;
const mockSparseEmbedder = (fastembedMock as any)._sparseEmbedder;

const mockConfig = {
  get: jest.fn().mockImplementation((key: string) => {
    if (key === 'QDRANT_URL') return 'http://localhost:6333';
    if (key === 'QDRANT_API_KEY') return 'test-key';
    if (key === 'FASTEMBED_CACHE_DIR') return '/tmp/fastembed-test';
    return undefined;
  }),
};

describe('QdrantService', () => {
  let service: QdrantService;

  beforeEach(async () => {
    jest.clearAllMocks();
    // Re-setup embedder mocks for each test
    mockDenseEmbedder.embed.mockReturnValue(
      (async function* () {
        yield [new Float32Array(384).fill(0.1)];
      })(),
    );
    mockSparseEmbedder.embed.mockReturnValue(
      (async function* () {
        yield [
          {
            indices: new Int32Array([0, 1]),
            values: new Float32Array([0.5, 0.3]),
          },
        ];
      })(),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QdrantService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<QdrantService>(QdrantService);
    service.onModuleInit();
    // Force embedder initialization
    await (service as any).ensureEmbedders();
  });

  it('onModuleInit creates qdrant client', () => {
    expect((service as any).client).toBeDefined();
  });

  it('onModuleInit throws when QDRANT_URL is not set', async () => {
    mockConfig.get.mockReturnValueOnce(undefined);
    const module2: TestingModule = await Test.createTestingModule({
      providers: [
        QdrantService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    const service2 = module2.get<QdrantService>(QdrantService);
    expect(() => service2.onModuleInit()).toThrow('QDRANT_URL is not set');
  });

  it('onModuleInit throws when QDRANT_API_KEY is not set', async () => {
    mockConfig.get
      .mockReturnValueOnce('http://localhost:6333') // QDRANT_URL
      .mockReturnValueOnce(undefined); // QDRANT_API_KEY
    const module3: TestingModule = await Test.createTestingModule({
      providers: [
        QdrantService,
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    const service3 = module3.get<QdrantService>(QdrantService);
    expect(() => service3.onModuleInit()).toThrow('QDRANT_API_KEY is not set');
  });

  it('getClient returns the client instance', () => {
    const client = service.getClient();
    expect(client).toBeDefined();
  });

  it('assertPrefix throws for non-prefixed collection', async () => {
    await expect(service.ensureCollection('bad-collection')).rejects.toThrow(
      'must start with',
    );
  });

  describe('ensureCollection', () => {
    it('creates collection if not exists', async () => {
      mockClient.getCollections.mockResolvedValueOnce({ collections: [] });
      await service.ensureCollection(validCollection);
      expect(mockClient.createCollection).toHaveBeenCalledWith(
        validCollection,
        expect.any(Object),
      );
    });

    it('skips creation if collection already exists', async () => {
      mockClient.getCollections.mockResolvedValueOnce({
        collections: [{ name: validCollection }],
      });
      await service.ensureCollection(validCollection);
      expect(mockClient.createCollection).not.toHaveBeenCalled();
    });

    it('swallows 409 conflict error', async () => {
      mockClient.getCollections.mockResolvedValueOnce({ collections: [] });
      mockClient.createCollection.mockRejectedValueOnce({ status: 409 });
      await expect(
        service.ensureCollection(validCollection),
      ).resolves.not.toThrow();
    });

    it('throws non-409 errors', async () => {
      mockClient.getCollections.mockResolvedValueOnce({ collections: [] });
      mockClient.createCollection.mockRejectedValueOnce(
        new Error('server error'),
      );
      await expect(service.ensureCollection(validCollection)).rejects.toThrow();
    });
  });

  describe('ensureDenseCollection', () => {
    it('creates dense collection if not exists', async () => {
      mockClient.getCollections.mockResolvedValueOnce({ collections: [] });
      await service.ensureDenseCollection(validCollection);
      expect(mockClient.createCollection).toHaveBeenCalled();
    });

    it('skips if already exists', async () => {
      mockClient.getCollections.mockResolvedValueOnce({
        collections: [{ name: validCollection }],
      });
      await service.ensureDenseCollection(validCollection);
      expect(mockClient.createCollection).not.toHaveBeenCalled();
    });

    it('swallows 409 conflict error', async () => {
      mockClient.getCollections.mockResolvedValueOnce({ collections: [] });
      mockClient.createCollection.mockRejectedValueOnce({ status: 409 });
      await expect(
        service.ensureDenseCollection(validCollection),
      ).resolves.not.toThrow();
    });
  });

  describe('upsertDense', () => {
    it('upserts a dense vector', async () => {
      await service.upsertDense(validCollection, 'id-1', [0.1, 0.2], {
        key: 'val',
      });
      expect(mockClient.upsert).toHaveBeenCalledWith(
        validCollection,
        expect.objectContaining({
          points: expect.arrayContaining([
            expect.objectContaining({ id: 'id-1' }),
          ]),
        }),
      );
    });
  });

  describe('embed', () => {
    it('returns embedding vector', async () => {
      const result = await service.embed('test text');
      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBe(384);
    });

    it('throws when embedder produces no output', async () => {
      mockDenseEmbedder.embed.mockReturnValueOnce(
        (async function* () {
          // yield nothing - empty
        })(),
      );
      await expect(service.embed('test')).rejects.toThrow('no output');
    });
  });

  describe('embedBatch', () => {
    it('returns batch of embedding vectors', async () => {
      mockDenseEmbedder.embed.mockReturnValue(
        (async function* () {
          yield [
            new Float32Array(384).fill(0.1),
            new Float32Array(384).fill(0.2),
          ];
        })(),
      );
      const result = await service.embedBatch(['text1', 'text2']);
      expect(result).toHaveLength(2);
    });
  });

  describe('sparseEmbed', () => {
    it('returns sparse embedding', async () => {
      const result = await service.sparseEmbed('test text');
      expect(result).toHaveProperty('indices');
      expect(result).toHaveProperty('values');
    });

    it('throws when sparse embedder produces no output', async () => {
      mockSparseEmbedder.embed.mockReturnValueOnce(
        (async function* () {
          // yield nothing
        })(),
      );
      await expect(service.sparseEmbed('test')).rejects.toThrow('no output');
    });
  });

  describe('searchHybrid', () => {
    it('returns search results', async () => {
      mockClient.query.mockResolvedValueOnce({
        points: [{ id: 'id-1', score: 0.9, payload: { name: 'test' } }],
      });
      const results = await service.searchHybrid(validCollection, 'query', 5);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('id-1');
    });
  });

  describe('searchHybridWithFilter', () => {
    it('returns filtered search results', async () => {
      mockClient.query.mockResolvedValueOnce({
        points: [{ id: 'id-2', score: 0.8, payload: {} }],
      });
      const results = await service.searchHybridWithFilter(
        validCollection,
        'query',
        { must: [] },
        5,
      );
      expect(results).toHaveLength(1);
    });
  });

  describe('recommendDense', () => {
    it('returns recommendation results', async () => {
      mockClient.query.mockResolvedValueOnce({
        points: [{ id: 'id-3', score: 0.7, payload: {} }],
      });
      const results = await service.recommendDense(
        validCollection,
        [[0.1, 0.2]],
        [],
        undefined,
        5,
      );
      expect(results).toHaveLength(1);
    });
  });
});
