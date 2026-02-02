import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';
import { RedisService } from './redis.service';
import { REDIS_CONNECTION } from './redis.constants';

export { REDIS_CONNECTION } from './redis.constants';

@Module({})
export class RedisModule {
  private static readonly logger = new Logger(RedisModule.name);

  static forRoot(): DynamicModule {
    return {
      module: RedisModule,
      global: true,
      imports: [ConfigModule],
      providers: [
        {
          provide: REDIS_CONNECTION,
          inject: [ConfigService],
          useFactory: (configService: ConfigService): Redis => {
            const redisUrl = configService.get<string>('REDIS_URL');
            const host = configService.get<string>('REDIS_HOST', 'localhost');
            const port = configService.get<number>('REDIS_PORT', 6379);
            const password = configService.get<string>('REDIS_PASSWORD');

            const redisOptions: RedisOptions = {
              retryStrategy: (times: number) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
              },
              maxRetriesPerRequest: 3,
            };

            let redis: Redis;

            if (
              redisUrl &&
              (redisUrl.startsWith('redis://') ||
                redisUrl.startsWith('rediss://'))
            ) {
              redis = new Redis(redisUrl, redisOptions);
            } else {
              redis = new Redis({
                ...redisOptions,
                host,
                port,
                ...(password ? { password } : {}),
              });
            }

            redis.on('error', (error) => {
              RedisModule.logger.error('Redis connection error:', error);
            });

            redis.on('connect', () => {
              RedisModule.logger.log('Redis client connected');
            });

            return redis;
          },
        },
        RedisService,
      ],
      exports: [REDIS_CONNECTION, RedisService],
    };
  }
}
