import { Test, TestingModule } from '@nestjs/testing';
import { BotDraftService, PublishJobDraft } from '../bot-draft.service';
import { REDIS_CONNECTION } from '../../../../common/services/redis/redis.constants';

const PROFILE_ID = 'profile-1';
const ENV = process.env.IS_PROD === 'true' ? 'prod' : 'dev';
const mockDraft: PublishJobDraft = {
  step: 3,
  payload: { title: 'Plombier', amount: 15000 },
  savedAt: new Date().toISOString(),
};

describe('BotDraftService', () => {
  let service: BotDraftService;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotDraftService,
        { provide: REDIS_CONNECTION, useValue: redis },
      ],
    }).compile();

    service = module.get<BotDraftService>(BotDraftService);
  });

  describe('saveDraft()', () => {
    it('saves draft as JSON with 7-day TTL', async () => {
      await service.saveDraft(PROFILE_ID, mockDraft);
      expect(redis.set).toHaveBeenCalledWith(
        `rabotka:${ENV}:bot:draft:publish:${PROFILE_ID}`,
        JSON.stringify(mockDraft),
        'EX',
        7 * 24 * 60 * 60,
      );
    });
  });

  describe('getDraft()', () => {
    it('returns parsed draft when found', async () => {
      redis.get.mockResolvedValue(JSON.stringify(mockDraft));
      const result = await service.getDraft(PROFILE_ID);
      expect(result?.step).toBe(3);
      expect(result?.payload).toEqual({ title: 'Plombier', amount: 15000 });
    });

    it('returns null when key not found', async () => {
      redis.get.mockResolvedValue(null);
      const result = await service.getDraft(PROFILE_ID);
      expect(result).toBeNull();
    });

    it('returns null for malformed JSON', async () => {
      redis.get.mockResolvedValue('{invalid}');
      const result = await service.getDraft(PROFILE_ID);
      expect(result).toBeNull();
    });
  });

  describe('clearDraft()', () => {
    it('deletes the draft key from Redis', async () => {
      await service.clearDraft(PROFILE_ID);
      expect(redis.del).toHaveBeenCalledWith(
        `rabotka:${ENV}:bot:draft:publish:${PROFILE_ID}`,
      );
    });
  });
});
