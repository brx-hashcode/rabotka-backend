import { DynamicModule, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';
import { RedisService } from './redis.service';
import { REDIS_CONNECTION } from './redis.constants';

export { REDIS_CONNECTION } from './redis.constants';

@Module({})
export class RedisModule {
  private static readonly logger = new Logger(RedisModule.name);

  /** App-level heartbeat. Managed Redis providers (Upstash, AWS NLB,
   *  Redis Cloud) drop idle TCP connections after ~30-60 s, surfacing as
   *  ECONNRESET. Sending PING every 25 s keeps the socket warm and
   *  prevents the noisy reconnect loop. */
  private static readonly HEARTBEAT_MS = 25_000;

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
                // Exponential-ish, capped at 5s. Returning null would
                // stop retrying — we want to keep trying forever.
                return Math.min(times * 200, 5_000);
              },
              maxRetriesPerRequest: 3,
              // Send TCP keep-alive probes every 30s. Combined with the
              // app-level heartbeat below this defends against both NAT
              // timers (kernel) and proxy idle-disconnects (app).
              keepAlive: 30_000,
              // Disable Nagle to reduce latency for small commands.
              noDelay: true,
              // Don't fail commands during the brief reconnect window —
              // queue them and replay once the socket is back.
              enableOfflineQueue: true,
              // Lazy connect lets us attach listeners before the first
              // connection attempt so we don't lose early events.
              lazyConnect: false,
              // Reconnect on these read-side errors. ioredis already
              // reconnects on ECONNRESET, but we make it explicit.
              reconnectOnError: (err) => {
                const msg = err.message || '';
                // READONLY: managed providers can hand us a replica
                // briefly during failover — reconnect to find the master.
                return (
                  msg.includes('READONLY') ||
                  msg.includes('ECONNRESET') ||
                  msg.includes('ETIMEDOUT')
                );
              },
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

            // ECONNRESET on an idle socket is *expected* with managed
            // Redis — log it as a warning, not an error, to keep the
            // operational logs honest. Anything else stays at error.
            redis.on('error', (error: NodeJS.ErrnoException) => {
              if (
                error.code === 'ECONNRESET' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'EPIPE'
              ) {
                RedisModule.logger.warn(
                  `Redis socket dropped (${error.code}) — reconnecting`,
                );
                return;
              }
              RedisModule.logger.error('Redis connection error:', error);
            });

            redis.on('connect', () => {
              RedisModule.logger.log('Redis client connected');
            });

            redis.on('ready', () => {
              RedisModule.logger.debug('Redis client ready');
            });

            redis.on('reconnecting', (delay: number) => {
              RedisModule.logger.debug(
                `Redis reconnecting in ${delay}ms`,
              );
            });

            // App-level PING heartbeat — keeps the connection warm
            // even when the app is idle (cron pauses, low traffic).
            const heartbeat = setInterval(() => {
              redis
                .ping()
                .catch(() => {
                  // ioredis will surface the failure via 'error'; no need
                  // to log twice. We swallow here to keep the interval
                  // alive.
                });
            }, RedisModule.HEARTBEAT_MS);
            // Don't keep the process alive just for the heartbeat.
            heartbeat.unref();

            // Stop pinging during graceful shutdown.
            redis.on('end', () => {
              clearInterval(heartbeat);
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
