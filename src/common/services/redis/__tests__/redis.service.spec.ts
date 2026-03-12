import { Logger } from '@nestjs/common';
import { RedisService } from '../redis.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

function makeRedis() {
  return {
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue('OK'),
  };
}

describe('RedisService', () => {
  let service: RedisService;
  let redis: ReturnType<typeof makeRedis>;

  beforeEach(() => {
    redis = makeRedis();
    service = new RedisService(redis as any);
  });

  describe('onModuleInit()', () => {
    it('pings Redis on init', async () => {
      await service.onModuleInit();
      expect(redis.ping).toHaveBeenCalled();
    });

    it('logs warning when Redis connection fails', async () => {
      redis.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await service.onModuleInit();
      // Should not throw — logs a warning instead
    });
  });

  describe('getClient()', () => {
    it('returns the Redis instance', () => {
      expect(service.getClient()).toBe(redis);
    });
  });

  describe('disconnect()', () => {
    it('calls redis.quit()', async () => {
      await service.disconnect();
      expect(redis.quit).toHaveBeenCalled();
    });
  });
});
