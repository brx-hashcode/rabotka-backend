import { Test, TestingModule } from '@nestjs/testing';
import { BotStateService } from '../bot-state.service';
import { REDIS_CONNECTION } from '../../../../common/services/redis/redis.constants';
import {
  BOT_STATE_KEY_PREFIX,
  BOT_STATE_TTL_SECONDS,
} from '../../bot.constants';
import { FLOW_IDS } from '../../bot.constants';

const PROFILE_ID = 'profile-1';

const mockState = {
  flowId: FLOW_IDS.LIST_OFFERS,
  step: 1,
  payload: { offerIds: ['a', 'b'] },
  updatedAt: new Date().toISOString(),
};

describe('BotStateService', () => {
  let service: BotStateService;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotStateService,
        { provide: REDIS_CONNECTION, useValue: redis },
      ],
    }).compile();

    service = module.get<BotStateService>(BotStateService);
  });

  describe('get()', () => {
    it('returns null when no state in Redis', async () => {
      redis.get.mockResolvedValue(null);
      const result = await service.get(PROFILE_ID);
      expect(result).toBeNull();
    });

    it('returns parsed BotState when found', async () => {
      redis.get.mockResolvedValue(JSON.stringify(mockState));
      const result = await service.get(PROFILE_ID);
      expect(result?.flowId).toBe(FLOW_IDS.LIST_OFFERS);
      expect(result?.step).toBe(1);
    });

    it('returns null when stored JSON has no flowId', async () => {
      redis.get.mockResolvedValue(JSON.stringify({ step: 1 }));
      const result = await service.get(PROFILE_ID);
      expect(result).toBeNull();
    });

    it('returns null when stored JSON is malformed', async () => {
      redis.get.mockResolvedValue('not-valid-json{{{');
      const result = await service.get(PROFILE_ID);
      expect(result).toBeNull();
    });

    it('uses correct Redis key', async () => {
      await service.get(PROFILE_ID);
      expect(redis.get).toHaveBeenCalledWith(
        `${BOT_STATE_KEY_PREFIX}${PROFILE_ID}`,
      );
    });
  });

  describe('set()', () => {
    it('serializes state and saves with TTL', async () => {
      await service.set(PROFILE_ID, mockState);
      expect(redis.set).toHaveBeenCalledWith(
        `${BOT_STATE_KEY_PREFIX}${PROFILE_ID}`,
        expect.any(String),
        'EX',
        BOT_STATE_TTL_SECONDS,
      );
    });

    it('stored JSON contains flowId and step', async () => {
      await service.set(PROFILE_ID, mockState);
      const stored = JSON.parse(redis.set.mock.calls[0][1]);
      expect(stored.flowId).toBe(FLOW_IDS.LIST_OFFERS);
      expect(stored.step).toBe(1);
    });

    it('adds/updates updatedAt field', async () => {
      await service.set(PROFILE_ID, mockState);
      const stored = JSON.parse(redis.set.mock.calls[0][1]);
      expect(stored.updatedAt).toBeDefined();
    });
  });

  describe('clear()', () => {
    it('deletes the Redis key', async () => {
      await service.clear(PROFILE_ID);
      expect(redis.del).toHaveBeenCalledWith(
        `${BOT_STATE_KEY_PREFIX}${PROFILE_ID}`,
      );
    });
  });
});
