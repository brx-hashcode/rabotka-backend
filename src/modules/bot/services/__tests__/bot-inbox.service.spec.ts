import { Test, TestingModule } from '@nestjs/testing';
import { BotInboxService, InboxItem } from '../bot-inbox.service';
import { REDIS_CONNECTION } from '../../../../common/services/redis/redis.constants';

const PROFILE_ID = 'profile-1';
const ENV = process.env.IS_PROD === 'true' ? 'prod' : 'dev';
const KEY = `rabotka:${ENV}:bot:inbox:${PROFILE_ID}`;
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
  let redis: {
    pipeline: jest.Mock;
    lrange: jest.Mock;
    lindex: jest.Mock;
    lpop: jest.Mock;
    llen: jest.Mock;
    eval: jest.Mock;
  };
  let pipelineMock: { rpush: jest.Mock; expire: jest.Mock; exec: jest.Mock };

  beforeEach(async () => {
    pipelineMock = {
      rpush: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        [null, 1],
        [null, 1],
      ]),
    };

    redis = {
      pipeline: jest.fn().mockReturnValue(pipelineMock),
      lrange: jest.fn().mockResolvedValue([]),
      lindex: jest.fn().mockResolvedValue(null),
      lpop: jest.fn().mockResolvedValue(null),
      llen: jest.fn().mockResolvedValue(0),
      eval: jest.fn().mockResolvedValue(null),
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
    it('appends item to inbox via pipeline', async () => {
      await service.push(PROFILE_ID, makeItem('app-1'));
      expect(redis.pipeline).toHaveBeenCalled();
      expect(pipelineMock.rpush).toHaveBeenCalledWith(KEY, expect.any(String));
      expect(pipelineMock.expire).toHaveBeenCalledWith(KEY, TTL);
      expect(pipelineMock.exec).toHaveBeenCalled();
    });

    it('serializes item as JSON', async () => {
      const item = makeItem('app-1');
      await service.push(PROFILE_ID, item);
      const serialized = pipelineMock.rpush.mock.calls[0][1];
      expect(JSON.parse(serialized).applicationId).toBe('app-1');
    });
  });

  describe('getAll()', () => {
    it('returns all items in inbox', async () => {
      redis.lrange.mockResolvedValue([
        JSON.stringify(makeItem('app-1')),
        JSON.stringify(makeItem('app-2')),
      ]);
      const items = await service.getAll(PROFILE_ID);
      expect(items).toHaveLength(2);
    });

    it('returns empty array when inbox is empty', async () => {
      redis.lrange.mockResolvedValue([]);
      const items = await service.getAll(PROFILE_ID);
      expect(items).toEqual([]);
    });

    it('skips malformed JSON entries', async () => {
      redis.lrange.mockResolvedValue([
        '{bad}',
        JSON.stringify(makeItem('app-1')),
      ]);
      const items = await service.getAll(PROFILE_ID);
      expect(items).toHaveLength(1);
    });
  });

  describe('shift()', () => {
    it('removes and returns the first item', async () => {
      redis.lpop.mockResolvedValue(JSON.stringify(makeItem('app-1')));
      const item = await service.shift(PROFILE_ID);
      expect(item?.applicationId).toBe('app-1');
      expect(redis.lpop).toHaveBeenCalledWith(KEY);
    });

    it('returns null when inbox is empty', async () => {
      redis.lpop.mockResolvedValue(null);
      const item = await service.shift(PROFILE_ID);
      expect(item).toBeNull();
    });

    it('returns null for malformed JSON', async () => {
      redis.lpop.mockResolvedValue('{bad}');
      const item = await service.shift(PROFILE_ID);
      expect(item).toBeNull();
    });
  });

  describe('peek()', () => {
    it('returns the first item without removing it', async () => {
      redis.lindex.mockResolvedValue(JSON.stringify(makeItem('app-1')));
      const item = await service.peek(PROFILE_ID);
      expect(item?.applicationId).toBe('app-1');
      expect(redis.lindex).toHaveBeenCalledWith(KEY, 0);
    });

    it('returns null when inbox is empty', async () => {
      redis.lindex.mockResolvedValue(null);
      const item = await service.peek(PROFILE_ID);
      expect(item).toBeNull();
    });

    it('returns null for malformed JSON', async () => {
      redis.lindex.mockResolvedValue('{bad}');
      const item = await service.peek(PROFILE_ID);
      expect(item).toBeNull();
    });
  });

  describe('peekAndShift()', () => {
    it('atomically reads and removes the first item', async () => {
      redis.eval.mockResolvedValue(JSON.stringify(makeItem('app-1')));
      const item = await service.peekAndShift(PROFILE_ID);
      expect(item?.applicationId).toBe('app-1');
    });

    it('returns null when inbox is empty', async () => {
      redis.eval.mockResolvedValue(null);
      const item = await service.peekAndShift(PROFILE_ID);
      expect(item).toBeNull();
    });

    it('returns null for malformed JSON', async () => {
      redis.eval.mockResolvedValue('{bad}');
      const item = await service.peekAndShift(PROFILE_ID);
      expect(item).toBeNull();
    });
  });

  describe('count()', () => {
    it('returns number of items in inbox', async () => {
      redis.llen.mockResolvedValue(3);
      const count = await service.count(PROFILE_ID);
      expect(count).toBe(3);
    });

    it('returns 0 when inbox is empty', async () => {
      redis.llen.mockResolvedValue(0);
      const count = await service.count(PROFILE_ID);
      expect(count).toBe(0);
    });
  });
});
