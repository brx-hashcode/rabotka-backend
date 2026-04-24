import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';

@WebSocketGateway({
  namespace: '/admin-notifications',
  cors: {
    origin: (origin: string, callback: (err: Error | null, allow?: boolean) => void) => {
      callback(null, true);
    },
    credentials: true,
  },
})
export class WsNotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(WsNotificationsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  afterInit(): void {
    const rootServer = (this.server as any)?.server ?? this.server;
    if (!rootServer?.adapter) {
      this.logger.debug('Socket.IO server not ready for Redis adapter, skipping');
      return;
    }

    const redisUrl = this.configService.get<string>('REDIS_URL');
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const password = this.configService.get<string>('REDIS_PASSWORD');

    try {
      let pubClient: Redis;
      if (
        redisUrl &&
        (redisUrl.startsWith('redis://') || redisUrl.startsWith('rediss://'))
      ) {
        pubClient = new Redis(redisUrl);
      } else {
        pubClient = new Redis({
          host,
          port,
          ...(password ? { password } : {}),
        });
      }

      const subClient = pubClient.duplicate();
      (rootServer as any).adapter(createAdapter(pubClient, subClient));
      this.logger.log('Socket.IO Redis adapter attached');
    } catch (err) {
      this.logger.warn('Failed to attach Redis adapter, running single-instance:', err);
    }
  }

  handleConnection(client: Socket): void {
    try {
      const token = this.extractToken(client);
      if (!token) {
        this.logger.debug('WS client rejected: no auth token');
        client.disconnect(true);
        return;
      }

      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      if (payload.type !== 'admin') {
        this.logger.debug('WS client rejected: not an admin');
        client.disconnect(true);
        return;
      }

      void client.join('admins');
      this.logger.log(`Admin ${payload.sub} connected via WebSocket`);
    } catch {
      this.logger.debug('WS client rejected: invalid token');
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`WS client disconnected: ${client.id}`);
  }

  emitToAdmin(userId: string, event: string, payload?: unknown): void {
    this.server.to('admins').emit(event, payload ?? {});
    this.logger.debug(`Emitted ${event} to admins room (triggered by ${userId})`);
  }

  private extractToken(client: Socket): string | undefined {
    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');
    const cookieHeader = client.handshake.headers.cookie;

    if (cookieName && cookieHeader) {
      const match = cookieHeader
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith(`${cookieName}=`));
      if (match) {
        return match.split('=').slice(1).join('=');
      }
    }

    const authHeader =
      client.handshake.headers.authorization ??
      (client.handshake.auth as Record<string, string>)?.token;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    if (typeof authHeader === 'string') {
      return authHeader;
    }

    return undefined;
  }
}
