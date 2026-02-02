import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from './redis.constants';

@Injectable()
export class RedisService implements OnModuleInit {
  private readonly logger = new Logger(RedisService.name);

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    try {
      await this.redis.ping();
      this.logger.log('✅ Redis connected successfully');
    } catch (error) {
      this.logger.error('❌ Redis connection failed:', error);
      throw error;
    }
  }

  getClient(): Redis {
    return this.redis;
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
