import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger, Inject, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { isSessionRevoked } from '../auth/session-revocation';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { socketCorsOrigin } from '../../common/utils/allowed-origins';
import {
  SESSION_ENDED,
  type SessionEndedEvent,
} from '../../common/events/session-ended.events';
import { OnEvent } from '@nestjs/event-emitter';

@WebSocketGateway({
  namespace: '/admin-notifications',
  cors: {
    origin: socketCorsOrigin,
    credentials: true,
  },
})
export class WsNotificationsGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleDestroy
{
  private readonly logger = new Logger(WsNotificationsGateway.name);
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  afterInit(): void {
    const rootServer = (this.server as any)?.server ?? this.server;
    if (!rootServer?.adapter) {
      this.logger.debug(
        'Socket.IO server not ready for Redis adapter, skipping',
      );
      return;
    }

    try {
      this.pubClient = this.redis.duplicate();
      this.subClient = this.redis.duplicate();
      rootServer.adapter(createAdapter(this.pubClient, this.subClient));
      this.logger.log('Socket.IO Redis adapter attached');
    } catch (err) {
      this.logger.warn(
        'Failed to attach Redis adapter, running single-instance:',
        err,
      );
    }
  }

  onModuleDestroy(): void {
    this.pubClient?.disconnect();
    this.subClient?.disconnect();
  }

  async handleConnection(client: Socket): Promise<void> {
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

      // Same two checks AdminAuthGuard makes on every HTTP request.
      const admin = (await isSessionRevoked(this.redis, payload.jti))
        ? null
        : await this.prisma.user.findUnique({
            where: { id: payload.sub },
            select: { is_active: true },
          });
      if (!admin?.is_active) {
        this.logger.debug('WS client rejected: signed out or deactivated');
        client.disconnect(true);
        return;
      }

      void client.join('admins');
      void client.join(`admin-${payload.sub}`);
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
    this.server.to(`admin-${userId}`).emit(event, payload ?? {});
    this.logger.debug(`Emitted ${event} to admin-${userId}`);
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
  /** Disconnects the sockets of a session that just ended (#864). */
  @OnEvent(SESSION_ENDED)
  evictEndedSession(event: SessionEndedEvent): void {
    if (event.kind !== 'admin') return;
    this.server?.in(`admin-${event.id}`).disconnectSockets(true);
  }
}
