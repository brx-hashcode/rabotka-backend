import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { SystemConfigService } from '../system-config.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';

const mockPrisma = {
  systemConfig: {
    upsert: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
};

const mockPipeline = {
  set: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([]),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  mget: jest.fn(),
  pipeline: jest.fn().mockReturnValue(mockPipeline),
};

describe('SystemConfigService', () => {
  let service: SystemConfigService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
    mockRedis.mget.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemConfigService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: REDIS_CONNECTION, useValue: mockRedis },
      ],
    }).compile();
    service = module.get<SystemConfigService>(SystemConfigService);
  });

  describe('onModuleInit', () => {
    it('seeds defaults on module init', async () => {
      await service.onModuleInit();
      expect(mockPrisma.systemConfig.upsert).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns cached value', async () => {
      mockRedis.get.mockResolvedValue('cached-value');
      const result = await service.get('some.key', 'fallback');
      expect(result).toBe('cached-value');
    });

    it('fetches from DB when cache miss and lock acquired', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValueOnce('OK'); // lock acquired
      mockPrisma.systemConfig.findUnique.mockResolvedValue({
        value: 'db-value',
      });

      const result = await service.get('some.key', 'fallback');
      expect(result).toBe('db-value');
    });

    it('returns fallback when lock not acquired', async () => {
      mockRedis.get
        .mockResolvedValueOnce(null) // cache miss
        .mockResolvedValueOnce(null); // after waiting, still not cached
      mockRedis.set.mockResolvedValue(null); // lock not acquired

      const result = await service.get('some.key', 'fallback');
      expect(result).toBe('fallback');
    }, 10000);

    it('returns fallback when DB has no record', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValueOnce('OK');
      mockPrisma.systemConfig.findUnique.mockResolvedValue(null);

      const result = await service.get('some.key', 'fallback');
      expect(result).toBe('fallback');
    });
  });

  describe('set', () => {
    it('updates config and clears cache', async () => {
      mockPrisma.systemConfig.update.mockResolvedValue({});
      await service.set('some.key', 'new-value', 'admin-1');
      expect(mockPrisma.systemConfig.update).toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalled();
    });

    it('throws BadRequestException when setting a fee key to zero', async () => {
      await expect(
        service.set('fees.late_cancellation_penalty_fcfa', '0', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.systemConfig.update).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when setting a fee key to a negative value', async () => {
      await expect(
        service.set('fees.contact_unlock_fee_employer', '-500', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when setting a fee key to a non-numeric string', async () => {
      await expect(
        service.set('fees.max_concurrent_applications', 'abc', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows setting non-fee keys to any string value', async () => {
      mockPrisma.systemConfig.update.mockResolvedValue({});
      await expect(
        service.set('contact.email', 'admin@example.com', 'admin-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('returns all config entries', async () => {
      mockPrisma.systemConfig.findMany.mockResolvedValue([
        {
          key: 'test.key',
          value: 'value',
          category: 'FEES',
          label: 'Test',
          is_secret: false,
          updated_at: new Date(),
          updated_by: null,
        },
      ]);
      const result = await service.getAll();
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('value');
    });

    it('masks secret values', async () => {
      mockPrisma.systemConfig.findMany.mockResolvedValue([
        {
          key: 'secret.key',
          value: 'secret',
          category: 'FEES',
          label: 'Secret',
          is_secret: true,
          updated_at: new Date(),
          updated_by: null,
        },
      ]);
      const result = await service.getAll();
      expect(result[0].value).toBe('***');
    });

    it('filters by category', async () => {
      mockPrisma.systemConfig.findMany.mockResolvedValue([]);
      await service.getAll('FEES' as any);
      expect(mockPrisma.systemConfig.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { category: 'FEES' },
        }),
      );
    });
  });

  describe('getOne', () => {
    it('returns null when not found', async () => {
      mockPrisma.systemConfig.findUnique.mockResolvedValue(null);
      const result = await service.getOne('missing.key');
      expect(result).toBeNull();
    });

    it('returns config entry', async () => {
      mockPrisma.systemConfig.findUnique.mockResolvedValue({
        key: 'test.key',
        value: 'value',
        category: 'FEES',
        label: 'Test',
        is_secret: false,
        updated_at: new Date(),
        updated_by: null,
      });
      const result = await service.getOne('test.key');
      expect(result?.key).toBe('test.key');
    });
  });

  describe('getRaw', () => {
    it('returns raw value', async () => {
      mockRedis.get.mockResolvedValue('raw-value');
      const result = await service.getRaw('some.key');
      expect(result).toBe('raw-value');
    });
  });

  describe('isSimilarityEnabled', () => {
    it('returns true when value is "true"', async () => {
      mockRedis.get.mockResolvedValue('true');
      const result = await service.isSimilarityEnabled();
      expect(result).toBe(true);
    });

    it('returns false when value is "false"', async () => {
      mockRedis.get.mockResolvedValue('false');
      const result = await service.isSimilarityEnabled();
      expect(result).toBe(false);
    });
  });

  describe('getContactInfo', () => {
    it('returns contact info with defaults', async () => {
      mockRedis.mget.mockResolvedValue([null, null, null]);
      mockPrisma.systemConfig.findMany.mockResolvedValue([]);
      const result = await service.getContactInfo();
      expect(result).toHaveProperty('email');
      expect(result).toHaveProperty('phone');
    });
  });

  describe('getFees', () => {
    it('returns fees with defaults', async () => {
      mockRedis.mget.mockResolvedValue([
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
      mockPrisma.systemConfig.findMany.mockResolvedValue([]);
      const result = await service.getFees();
      expect(result.lateCancellationPenaltyFcfa).toBe(5000);
      expect(result.cancellationThresholdHours).toBe(4);
    });
  });

  describe('getContactUnlockFees', () => {
    it('returns parsed fees when all configured', async () => {
      mockRedis.mget.mockResolvedValue(['500', '100', '24']);
      const result = await service.getContactUnlockFees();
      expect(result.employerFeeFcfa).toBe(500);
      expect(result.workerFeeFcfa).toBe(100);
      expect(result.expiryHours).toBe(24);
    });

    it('throws when expiryHours not configured', async () => {
      mockRedis.mget.mockResolvedValue(['500', '100', null]);
      mockPrisma.systemConfig.findMany.mockResolvedValueOnce([]);
      await expect(service.getContactUnlockFees()).rejects.toThrow(
        'fees.contact_unlock_expiry_hours',
      );
    });
  });

  describe('getMatchingReliabilityThreshold', () => {
    it('returns a number', async () => {
      mockRedis.get.mockResolvedValue('75');
      const result = await service.getMatchingReliabilityThreshold();
      expect(result).toBe(75);
    });
  });

  describe('getRecommendationContactFee', () => {
    it('returns a number', async () => {
      mockRedis.get.mockResolvedValue('1500');
      const result = await service.getRecommendationContactFee();
      expect(result).toBe(1500);
    });
  });

  describe('getWelcomeCredits', () => {
    it('returns worker and employer credits', async () => {
      mockRedis.get.mockResolvedValue('200');
      const result = await service.getWelcomeCredits();
      expect(result.workerCreditFcfa).toBe(200);
      expect(result.employerCreditFcfa).toBe(200);
    });
  });

  describe('getStorageDriver', () => {
    it('returns storage driver', async () => {
      mockRedis.get.mockResolvedValue('S3');
      const result = await service.getStorageDriver();
      expect(result).toBe('S3');
    });
  });

  describe('getPaymentGatewayDriver', () => {
    it('returns payment gateway driver', async () => {
      mockRedis.get.mockResolvedValue('MONETBIL');
      const result = await service.getPaymentGatewayDriver();
      expect(result).toBe('MONETBIL');
    });
  });

  describe('getPaymentEnvOverrides', () => {
    it('returns empty for unknown driver', async () => {
      const result = await service.getPaymentEnvOverrides('UNKNOWN');
      expect(result).toEqual({});
    });

    it('returns overrides for MONETBIL driver', async () => {
      mockRedis.get.mockResolvedValue('service-key');
      const result = await service.getPaymentEnvOverrides('MONETBIL');
      expect(typeof result).toBe('object');
    });
  });

  describe('getMonetbilConfig', () => {
    it('returns service key', async () => {
      mockRedis.get.mockResolvedValue('mk-key');
      const result = await service.getMonetbilConfig();
      expect(result.serviceKey).toBe('mk-key');
    });
  });

  describe('getMonetbilEnvOverrides', () => {
    it('returns env overrides', async () => {
      mockRedis.get.mockResolvedValue('val');
      const result = await service.getMonetbilEnvOverrides();
      expect(typeof result).toBe('object');
    });
  });

  describe('getStorageEnvOverrides', () => {
    it('returns empty for unknown driver', async () => {
      const result = await service.getStorageEnvOverrides('UNKNOWN_DRIVER');
      expect(result).toEqual({});
    });

    it('returns overrides for S3 driver', async () => {
      mockRedis.get.mockResolvedValue('bucket-val');
      const result = await service.getStorageEnvOverrides('S3');
      expect(typeof result).toBe('object');
    });
  });

  describe('onModuleInit retry', () => {
    it('throws immediately on non-retryable error', async () => {
      mockPrisma.systemConfig.upsert.mockRejectedValue(
        new Error('permission denied'),
      );
      await expect(service.onModuleInit()).rejects.toThrow('permission denied');
    });
  });

  describe('set without adminId', () => {
    it('updates with null updated_by', async () => {
      mockPrisma.systemConfig.update.mockResolvedValue({});
      await service.set('test.key', 'new-val');
      expect(mockPrisma.systemConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ updated_by: null }),
        }),
      );
    });
  });
});
