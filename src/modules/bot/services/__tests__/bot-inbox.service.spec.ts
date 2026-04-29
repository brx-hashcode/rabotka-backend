import { Test, TestingModule } from '@nestjs/testing';
import { BotInboxService, InboxItem } from '../bot-inbox.service';
import { REDIS_CONNECTION } from '../../../../common/services/redis/redis.constants';

const PROFILE_ID = 'profile-1';
const TTL = 7 * 24 * 60 * 60;

function makeItem(id: string): InboxItem {
  return {
    type: 'new_application',
    applicationId: id,
    workerName: 'Alice',
    offerTitle: 'Plombier',
    createdAt: new Date().toISOString(),
  };
}

describe('BotInboxService', () => {
  let service: BotInboxService;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BotInboxService,
        { provide: REDIS_CONNECTION, useValue: redis },
      ],
    }).compile();

    service = module.get<BotInboxService>(BotInboxService);
  });

  describe('push()', () => {
    it('appends item to empty inbox', async () => {
      redis.get.mockResolvedValue(null);
      await service.push(PROFILE_ID, makeItem('app-1'));
      const stored = JSON.parse(redis.set.mock.calls[0][1]);
      expect(stored).toHaveLength(1);
      expect(stored[0].applicationId).toBe('app-1');
    });

    it('appends item to existing inbox', async () => {
      redis.get.mockResolvedValue(JSON.stringify([makeItem('app-1')]));
      await service.push(PROFILE_ID, makeItem('app-2'));
      const stored = JSON.parse(redis.set.mock.calls[0][1]);
      expect(stored).toHaveLength(2);
      expect(stored[1].applicationId).toBe('app-2');
    });

    it('saves with 7-day TTL', async () => {
      await service.push(PROFILE_ID, makeItem('app-1'));
      expect(redis.set).toHaveBeenCalledWith(
        `bot:inbox:${PROFILE_ID}`,
        expect.any(String),
        'EX',
        TTL,
      );
    });
  });

  describe('getAll()', () => {
    it('returns all items in inbox', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify([makeItem('app-1'), makeItem('app-2')]),
      );
      const items = await service.getAll(PROFILE_ID);
      expect(items).toHaveLength(2);
    });

    it('returns empty array when inbox is empty', async () => {
      redis.get.mockResolvedValue(null);
      const items = await service.getAll(PROFILE_ID);
      expect(items).toEqual([]);
    });

    it('returns empty array for malformed JSON', async () => {
      redis.get.mockResolvedValue('{bad}');
      const items = await service.getAll(PROFILE_ID);
      expect(items).toEqual([]);
    });
  });

  describe('shift()', () => {
    it('removes and returns the first item', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify([makeItem('app-1'), makeItem('app-2')]),
      );
      const item = await service.shift(PROFILE_ID);
      expect(item?.applicationId).toBe('app-1');
      // Should update redis with remaining items
      expect(redis.set).toHaveBeenCalled();
    });

    it('deletes Redis key when inbox becomes empty after shift', async () => {
      redis.get.mockResolvedValue(JSON.stringify([makeItem('app-1')]));
      const item = await service.shift(PROFILE_ID);
      expect(item?.applicationId).toBe('app-1');
      expect(redis.del).toHaveBeenCalledWith(`bot:inbox:${PROFILE_ID}`);
    });

    it('returns null when inbox is empty', async () => {
      redis.get.mockResolvedValue(null);
      const item = await service.shift(PROFILE_ID);
      expect(item).toBeNull();
    });

    it('returns null for empty array', async () => {
      redis.get.mockResolvedValue(JSON.stringify([]));
      const item = await service.shift(PROFILE_ID);
      expect(item).toBeNull();
    });

    it('returns null for malformed JSON', async () => {
      redis.get.mockResolvedValue('{bad}');
      const item = await service.shift(PROFILE_ID);
      expect(item).toBeNull();
    });
  });

  describe('count()', () => {
    it('returns number of items in inbox', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify([makeItem('a'), makeItem('b'), makeItem('c')]),
      );
      const count = await service.count(PROFILE_ID);
      expect(count).toBe(3);
    });

    it('returns 0 when inbox is empty', async () => {
      redis.get.mockResolvedValue(null);
      const count = await service.count(PROFILE_ID);
      expect(count).toBe(0);
    });
  });
});
