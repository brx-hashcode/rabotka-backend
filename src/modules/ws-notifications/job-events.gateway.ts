import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { isSessionRevoked } from '../auth/session-revocation';
import { Logger, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import { socketCorsOrigin } from '../../common/utils/allowed-origins';
import {
  SESSION_ENDED,
  type SessionEndedEvent,
} from '../../common/events/session-ended.events';
import { OnEvent } from '@nestjs/event-emitter';

/** What moved. The client turns this into the query keys it needs to drop. */
export type JobEvent = {
  jobOfferId: string;
  applicationId: string;
  /**
   * `completed` — the worker confirmed their mission (and the offer may have
   * closed with it). `rated` — the employer rated the worker.
   */
  kind: 'completed' | 'rated';
};

/**
 * Tells the *other* party a job moved.
 *
 * A mission has two sides acting on it from two devices, and each side's action
 * changes what the other one should be looking at: the worker confirming is what
 * unlocks the employer's rating action, and the employer rating is what removes
 * it. `invalidateQueries` only ever refreshes the browser that performed the
 * mutation, so without a push the counterparty sits on a stale screen until they
 * reload — which, inside WhatsApp's webview, they may never do: it fires no
 * focus or reconnect events.
 *
 * The room comes from the handshake JWT, never from a client-supplied id, or
 * anyone could subscribe to another profile's job activity. Sockets are only an
 * optimisation — a client that never connects still gets correct data on its
 * next fetch.
 */
@WebSocketGateway({
  namespace: '/job-events',
  cors: {
    origin: socketCorsOrigin,
    credentials: true,
  },
})
export class JobEventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(JobEventsGateway.name);

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
      this.logger.debug(`Job events client ${client.id} rejected: no token`);
      client.disconnect(true);
      return;
    }

    void client.join(`profile:${profileId}`);
    this.logger.debug(`Job events client ${client.id} joined ${profileId}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Job events client disconnected: ${client.id}`);
  }

  /**
   * Notifies both sides of a mission at once.
   *
   * Both, not just the counterparty: the acting client has already invalidated
   * locally, and a second refresh there is harmless — whereas working out which
   * socket performed the mutation would be guesswork. Deduplicated so a worker
   * rating themselves (impossible today, but cheap to guard) emits once.
   */
  emitJobChanged(profileIds: readonly string[], event: JobEvent): void {
    for (const profileId of new Set(profileIds.filter(Boolean))) {
      this.server.to(`profile:${profileId}`).emit('job:changed', event);
    }
  }

  /** Reads the auth cookie (or `auth.token`) off the handshake and verifies it. */
  private async resolveProfileId(client: Socket): Promise<string | null> {
    const token = this.extractToken(client);
    if (!token) return null;

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Admins have no missions — only profile tokens map to a room.
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
