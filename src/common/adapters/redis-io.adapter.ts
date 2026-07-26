import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter backed by Redis pub/sub so rooms and emits work across
 * multiple API instances (chat, notifications, etc. all benefit). Falls back to
 * the default in-memory adapter if Redis can't be reached, so a single-instance
 * / local run still works.
 */
export class RedisIoAdapter extends IoAdapter {
  private static readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  async connectToRedis(config: ConfigService): Promise<void> {
    try {
      const url = config.get<string>('REDIS_URL');
      const pubClient =
        url && (url.startsWith('redis://') || url.startsWith('rediss://'))
          ? new Redis(url, { maxRetriesPerRequest: null })
          : new Redis({
              host: config.get<string>('REDIS_HOST', 'localhost'),
              port: config.get<number>('REDIS_PORT', 6379),
              ...(config.get<string>('REDIS_PASSWORD')
                ? { password: config.get<string>('REDIS_PASSWORD') }
                : {}),
              maxRetriesPerRequest: null,
            });
      const subClient = pubClient.duplicate();
      // Verify connectivity so an unreachable Redis falls back cleanly.
      await Promise.all([pubClient.ping(), subClient.ping()]);
      this.adapterConstructor = createAdapter(pubClient, subClient);
      RedisIoAdapter.logger.log('Socket.IO Redis adapter connected');
    } catch (err) {
      RedisIoAdapter.logger.warn(
        `Socket.IO Redis adapter unavailable, using in-memory adapter: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
