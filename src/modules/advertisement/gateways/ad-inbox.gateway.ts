import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { isSessionRevoked } from '../../auth/session-revocation';
import { Logger, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../../auth/guards/jwt-auth.guard';
import { socketCorsOrigin } from '../../../common/utils/allowed-origins';
import {
  SESSION_ENDED,
  type SessionEndedEvent,
} from '../../../common/events/session-ended.events';
import { OnEvent } from '@nestjs/event-emitter';

export type InAppAdPayload = {
  deliveryId: string;
  advertisementId: string;
  title: string;
  description: string;
  imageUrl: string | null;
  callToAction: string | null;
  ctaUrl: string | null;
  tags: string[];
};

/**
 * Pushes in-app advertisements to the web client the moment they are dispatched.
 *
 * Unlike the payment/claim gateways, the room is derived from the handshake JWT
 * rather than from a client-supplied id — otherwise anyone could subscribe to
 * another profile's deliveries. Sockets are only an optimisation: a client that
 * never connects still picks the ad up from GET /ads/inbox.
 */
@WebSocketGateway({
  namespace: '/ad-inbox',
  cors: {
    origin: socketCorsOrigin,
    credentials: true,
  },
})
export class AdInboxGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(AdInboxGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const profileId = await this.resolveProfileId(client);

    if (!profileId) {
      this.logger.debug(
        `Ad inbox client ${client.id} rejected: no profile token`,
      );
      client.disconnect(true);
      return;
    }

    void client.join(`profile:${profileId}`);
    this.logger.debug(
      `Ad inbox client ${client.id} joined profile:${profileId}`,
    );
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Ad inbox client disconnected: ${client.id}`);
  }

  emitNewAd(profileId: string, ad: InAppAdPayload): void {
    this.server.to(`profile:${profileId}`).emit('ad:new', ad);
  }

  /** Reads the auth cookie (or `auth.token`) off the handshake and verifies it. */
  private async resolveProfileId(client: Socket): Promise<string | null> {
    const token = this.extractToken(client);
    if (!token) return null;

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Admins have no ad inbox — only profile tokens map to a room.
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
  /** Disconnects the sockets of a session that just ended (#864). */
  @OnEvent(SESSION_ENDED)
  evictEndedSession(event: SessionEndedEvent): void {
    if (event.kind !== 'profile') return;
    this.server?.in(`profile:${event.id}`).disconnectSockets(true);
  }
}
