import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/websockets';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { isSessionRevoked } from '../auth/session-revocation';
import { Logger, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import type { ProfileNotificationDto } from './profile-notification.service';
import { socketCorsOrigin } from '../../common/utils/allowed-origins';

/**
 * Pushes a new notification to the recipient's open tabs, so the bell updates
 * without waiting for the poll.
 *
 * Same contract as `JobEventsGateway`: the room comes from the handshake JWT,
 * never from the client, and the socket is only an optimisation — a client that
 * never connects still sees the notification on its next fetch.
 */
@WebSocketGateway({
  namespace: '/notifications',
  cors: {
    origin: socketCorsOrigin,
    credentials: true,
  },
})
export class ProfileNotificationsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ProfileNotificationsGateway.name);

  @WebSocketServer()
  server?: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const profileId = await this.resolveProfileId(client);

    if (!profileId) {
      this.logger.debug(`Notifications client ${client.id} rejected`);
      client.disconnect(true);
      return;
    }

    void client.join(`profile:${profileId}`);
  }

  emitNew(profileId: string, notification: ProfileNotificationDto): void {
    // No server outside the HTTP app (the queue worker, specs).
    this.server
      ?.to(`profile:${profileId}`)
      .emit('notification:new', notification);
  }

  private async resolveProfileId(client: Socket): Promise<string | null> {
    const token = this.extractToken(client);
    if (!token) return null;

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Admins have their own feed, on `/admin-notifications`.
      if ((payload.type ?? 'profile') !== 'profile') return null;

      // A session the user signed out of must not keep its sockets either.
      if (await isSessionRevoked(this.redis, payload.jti)) return null;

      return payload.sub || null;
    } catch {
      return null;
    }
  }

  private extractToken(client: Socket): string | undefined {
    const authToken = client.handshake.auth?.token;
    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken;
    }

    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');
    const cookieHeader = client.handshake.headers.cookie;
    if (!cookieName || !cookieHeader) return undefined;

    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === cookieName) {
        return decodeURIComponent(rest.join('='));
      }
    }

    return undefined;
  }
}
