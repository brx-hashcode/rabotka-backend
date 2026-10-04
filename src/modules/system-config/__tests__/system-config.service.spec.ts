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
  // Array form. `setMany` builds one `systemConfig.update(...)` per key and
  // hands the array over, so awaiting them here keeps the assertions on
  // `systemConfig.update` meaningful while still exercising the batching.
  $transaction: jest.fn((ops: unknown) => Promise.all(ops as Promise<never>[])),
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
        service.set('fees.max_daily_applications', 'abc', 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows setting non-fee keys to any string value', async () => {
      mockPrisma.systemConfig.update.mockResolvedValue({});
      await expect(
        service.set('contact.email', 'admin@example.com', 'admin-1'),
      ).resolves.toBeUndefined();
    });

    /**
     * `matching.embeddings_enabled_at` is what lets `reindexPending` tell a real
     * index from the stamp written while embeddings were off. It must move on
     * the false→true transition and at no other time — a stamp written on a
     * no-op save would jump past every `vector_indexed_at` recorded since the
     * real activation and strand exactly the rows it exists to reclaim.
     */
    describe('matching.embeddings_enabled_at', () => {
      const ENABLED_AT = 'matching.embeddings_enabled_at';
      const upsertedKeys = () =>
        mockPrisma.systemConfig.upsert.mock.calls.map((c) => c[0].where.key);

      beforeEach(() => {
        mockPrisma.systemConfig.update.mockResolvedValue({});
      });

      it('is stamped when embeddings go from off to on', async () => {
        mockRedis.get.mockResolvedValue('false'); // prior value

        await service.set('matching.use_embeddings', 'true', 'admin-1');

        expect(upsertedKeys()).toContain(ENABLED_AT);
        const call = mockPrisma.systemConfig.upsert.mock.calls.find(
          (c) => c[0].where.key === ENABLED_AT,
        );
        expect(Number.isNaN(Date.parse(call![0].update.value))).toBe(false);
      });

      it('is not moved when embeddings were already on', async () => {
        mockRedis.get.mockResolvedValue('true'); // already enabled

        await service.set('matching.use_embeddings', 'true', 'admin-1');

        expect(upsertedKeys()).not.toContain(ENABLED_AT);
      });

      it('is not stamped when embeddings are turned off', async () => {
        mockRedis.get.mockResolvedValue('true');

        await service.set('matching.use_embeddings', 'false', 'admin-1');

        expect(upsertedKeys()).not.toContain(ENABLED_AT);
      });

      it('does not fail the admin write when the stamp cannot be saved', async () => {
        mockRedis.get.mockResolvedValue('false');
        mockPrisma.systemConfig.upsert.mockRejectedValue(new Error('db down'));

        await expect(
          service.set('matching.use_embeddings', 'true', 'admin-1'),
        ).resolves.toBeUndefined();
        // The config change itself still landed.
        expect(mockPrisma.systemConfig.update).toHaveBeenCalled();
      });
    });
  });

  describe('getEmbeddingsEnabledAt', () => {
    it('parses a stored ISO timestamp', async () => {
      mockRedis.get.mockResolvedValue('2026-08-16T10:00:00.000Z');
      const result = await service.getEmbeddingsEnabledAt();
      expect(result?.toISOString()).toBe('2026-08-16T10:00:00.000Z');
    });

    it('returns null when never enabled', async () => {
      mockRedis.get.mockResolvedValue('');
      await expect(service.getEmbeddingsEnabledAt()).resolves.toBeNull();
    });

    // Degrades to the original null-stamp-only scan rather than matching every
    // row on every pass, which would re-index the whole corpus every 30 minutes.
    it('returns null for an unparseable value', async () => {
      mockRedis.get.mockResolvedValue('not-a-date');
      await expect(service.getEmbeddingsEnabledAt()).resolves.toBeNull();
    });
  });

  /**
   * The parrainage block is the reason `setMany` exists: the commission type
   * decides what unit the two credit values are in, so "300 FCFA → 60 %" is
   * three writes that are each invalid alone and only coherent together.
   */
  describe('setMany — the parrainage block', () => {
    const TYPE = 'fees.referral_commission_type';
    const REFERRER = 'fees.referral_credit_referrer';
    const REFEREE = 'fees.referral_credit_referee';

    /** What is already stored for the keys this write does not carry. */
    function givenStored(values: Record<string, string>) {
      mockPrisma.systemConfig.findMany.mockResolvedValue(
        Object.entries(values).map(([key, value]) => ({ key, value })),
      );
    }

    beforeEach(() => {
      mockPrisma.systemConfig.update.mockResolvedValue({});
      mockPrisma.systemConfig.findMany.mockResolvedValue([]);
    });

    it('switches type and both amounts in one transaction', async () => {
      givenStored({});
      await service.setMany(
        { [TYPE]: 'PERCENTAGE', [REFERRER]: '60', [REFEREE]: '40' },
        'admin-1',
      );

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.systemConfig.update).toHaveBeenCalledTimes(3);
      expect(mockRedis.del).toHaveBeenCalled();
    });

    it('rejects an empty body rather than writing nothing quietly', async () => {
      await expect(service.setMany({}, 'admin-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects an unknown commission type', async () => {
      givenStored({});
      await expect(
        service.setMany({ [TYPE]: 'SLIDING_SCALE' }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects percentages summing past 100, writing nothing', async () => {
      givenStored({});
      await expect(
        service.setMany(
          { [TYPE]: 'PERCENTAGE', [REFERRER]: '70', [REFEREE]: '40' },
          'admin-1',
        ),
      ).rejects.toThrow(/100 %/);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts percentages summing to exactly 100', async () => {
      givenStored({});
      await expect(
        service.setMany(
          { [TYPE]: 'PERCENTAGE', [REFERRER]: '60', [REFEREE]: '40' },
          'admin-1',
        ),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['a fractional percentage', '62.5'],
      ['a percentage above 100', '140'],
      ['a negative percentage', '-10'],
      ['a non-numeric value', 'soixante'],
    ])('rejects %s in PERCENTAGE mode', async (_label, referrer) => {
      givenStored({});
      await expect(
        service.setMany(
          { [TYPE]: 'PERCENTAGE', [REFERRER]: referrer, [REFEREE]: '10' },
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows amounts far above 100 in FIXED mode — they are francs', async () => {
      givenStored({});
      await expect(
        service.setMany(
          { [TYPE]: 'FIXED', [REFERRER]: '300', [REFEREE]: '200' },
          'admin-1',
        ),
      ).resolves.toBeUndefined();
    });

    it('rejects a negative amount in FIXED mode', async () => {
      givenStored({});
      await expect(
        service.setMany({ [TYPE]: 'FIXED', [REFERRER]: '-300' }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    /**
     * The hole the single-key endpoint used to leave open: one write that is
     * valid on its own but incoherent with what is already stored.
     */
    it('guards a single-key write against the stored rest of the block', async () => {
      givenStored({ [TYPE]: 'PERCENTAGE', [REFEREE]: '40' });
      await expect(service.set(REFERRER, '80', 'admin-1')).rejects.toThrow(
        /100 %/,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('lets the same single-key write through when the block stays coherent', async () => {
      givenStored({ [TYPE]: 'PERCENTAGE', [REFEREE]: '40' });
      await expect(
        service.set(REFERRER, '55', 'admin-1'),
      ).resolves.toBeUndefined();
    });

    it('does not read the parrainage block for an unrelated key', async () => {
      await service.set('contact.email', 'admin@example.com', 'admin-1');
      expect(mockPrisma.systemConfig.findMany).not.toHaveBeenCalled();
    });

    it.each([
      ['fees.referral_max_rewarded_per_referrer', '-1'],
      ['fees.referral_max_payout_per_referral', '-1'],
      ['fees.referral_max_payout_per_referral', 'beaucoup'],
    ])('rejects a negative or unparseable %s', async (key, value) => {
      givenStored({});
      await expect(service.set(key, value, 'admin-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('accepts zero for both caps — zero means off, not broken', async () => {
      givenStored({});
      await expect(
        service.setMany(
          {
            'fees.referral_max_rewarded_per_referrer': '0',
            'fees.referral_max_payout_per_referral': '0',
          },
          'admin-1',
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('setMany — agent commissions', () => {
    const AMOUNT = 'agent.commission_per_placement_fcfa';
    const EMPLOYER_FEE = 'fees.contact_unlock_fee_employer';

    beforeEach(() => {
      mockPrisma.systemConfig.update.mockResolvedValue({});
      // Stored: commission 400, fees 500 + 100.
      mockPrisma.systemConfig.findMany.mockResolvedValue([
        { key: AMOUNT, value: '400' },
        { key: EMPLOYER_FEE, value: '500' },
        { key: 'fees.contact_unlock_fee_worker', value: '100' },
      ]);
    });

    it('refuses a commission that would eat the whole unlock fee', async () => {
      await expect(
        service.setMany({ [AMOUNT]: '600' }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.systemConfig.update).not.toHaveBeenCalled();
    });

    it('refuses lowering a fee under the commission already set', async () => {
      await expect(
        service.setMany({ [EMPLOYER_FEE]: '250' }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts a commission below the fees, and 0 to turn it off', async () => {
      await service.setMany({ [AMOUNT]: '450' }, 'admin-1');
      await service.setMany({ [AMOUNT]: '0' }, 'admin-1');
      expect(mockPrisma.systemConfig.update).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['agent.commission_release_event', 'PAID'],
      ['agent.commission_multi_seat_mode', 'EVERY_SEAT'],
      ['agent.commission_requires_momo_worker', 'yes'],
      ['agent.commission_confirmation_hours', '-1'],
    ])('refuses %s = %s', async (key, value) => {
      await expect(
        service.setMany({ [key]: value }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getAgentCommissionSettings', () => {
    it('falls back to the safe defaults when nothing is stored', async () => {
      mockRedis.mget.mockResolvedValue(Array<null>(6).fill(null));
      mockPrisma.systemConfig.findMany.mockResolvedValue([]);
      await expect(service.getAgentCommissionSettings()).resolves.toEqual({
        amountFcfa: 400,
        releaseEvent: 'UNLOCKED',
        confirmationHours: 72,
        requiresMomoWorker: true,
        requiresMomoEmployer: true,
        multiSeatMode: 'PER_PLACEMENT',
      });
    });

    it('reads what is stored', async () => {
      mockRedis.mget.mockResolvedValue([
        '300',
        'COMPLETED',
        '0',
        'false',
        'true',
        'FIRST_ONLY',
      ]);
      await expect(service.getAgentCommissionSettings()).resolves.toEqual({
        amountFcfa: 300,
        releaseEvent: 'COMPLETED',
        confirmationHours: 0,
        requiresMomoWorker: false,
        requiresMomoEmployer: true,
        multiSeatMode: 'FIRST_ONLY',
      });
    });
  });

  describe('getReferralCredits', () => {
    function givenStored(values: Record<string, string>) {
      mockPrisma.systemConfig.findMany.mockResolvedValue(
        Object.entries(values).map(([key, value]) => ({ key, value })),
      );
    }

    it('defaults to FIXED with the seeded amounts when nothing is stored', async () => {
      givenStored({});
      await expect(service.getReferralCredits()).resolves.toEqual({
        commissionType: 'FIXED',
        referrerCreditFcfa: 300,
        refereeCreditFcfa: 200,
        maxRewardedPerReferrer: 10,
        maxPayoutPerReferralFcfa: 0,
      });
    });

    it('reads a PERCENTAGE configuration back', async () => {
      givenStored({
        'fees.referral_commission_type': 'PERCENTAGE',
        'fees.referral_credit_referrer': '60',
        'fees.referral_credit_referee': '40',
      });
      await expect(service.getReferralCredits()).resolves.toMatchObject({
        commissionType: 'PERCENTAGE',
        referrerCreditFcfa: 60,
        refereeCreditFcfa: 40,
      });
    });

    // A row saying something else is a bug, and the safe reading of a broken
    // type is the one whose amounts an admin typed — not one that reinterprets
    // 300 as 300 %.
    it('falls back to FIXED for an unrecognised stored type', async () => {
      givenStored({ 'fees.referral_commission_type': 'SLIDING_SCALE' });
      await expect(service.getReferralCredits()).resolves.toMatchObject({
        commissionType: 'FIXED',
      });
    });

    it('resolves a zero or negative referral cap to null (unlimited)', async () => {
      givenStored({ 'fees.referral_max_rewarded_per_referrer': '0' });
      await expect(service.getReferralCredits()).resolves.toMatchObject({
        maxRewardedPerReferrer: null,
      });
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
      await service.getAll('FEES');
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
      // getFees requests 14 keys — return all null so every value falls back.
      mockRedis.mget.mockResolvedValue(Array<null>(32).fill(null));
      mockPrisma.systemConfig.findMany.mockResolvedValue([]);
      const result = await service.getFees();
      expect(result.lateCancellationPenaltyFcfa).toBe(5000);
      expect(result.cancellationThresholdHours).toBe(4);
    });

    it('returns the completion reward and per-star rating deltas (defaults)', async () => {
      mockRedis.mget.mockResolvedValue(Array<null>(32).fill(null));
      mockPrisma.systemConfig.findMany.mockResolvedValue([]);
      const result = await service.getFees();
      expect(result.completionScoreReward).toBe(1);
      expect(result.ratingScoreDeltas).toEqual({
        1: -4,
        2: -2,
        3: 0,
        4: 1,
        5: 3,
      });
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
