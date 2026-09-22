import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import type { MessageView } from './profile-chat.service';
import { PresenceService } from './presence.service';

/** Well under the 90s TTL, so one missed tick never drops somebody offline. */
const PRESENCE_REFRESH_MS = 45_000;

/**
 * Pushes a new message to the recipient's open tabs.
 *
 * DELIBERATELY PUSH-ONLY: not one `@SubscribeMessage` in this file, and there
 * never should be. Sending goes over REST, where the global `ValidationPipe`
 * applies — it does not run on gateways, which is exactly how `chat.gateway.ts`
 * ended up accepting a socket message body that no DTO validates. An inbound
 * handler here would recreate that hole and bypass the moderation the
 * controller enforces.
 *
 * Same contract as `ProfileNotificationsGateway`, down to the room name: the
 * room comes from the handshake JWT and NEVER from the client, and the socket
 * is only an optimisation — a client that never connects still sees the message
 * on its next fetch, and the in-app bell is raised separately.
 *
 * One room per profile rather than per conversation. With exactly two parties
 * `to('profile:x')` is just as precise, and it avoids the join/leave
 * bookkeeping `chat.gateway.ts` has to do on every connect.
 */
@WebSocketGateway({
  namespace: '/messagerie',
  cors: {
    origin: (
      _origin: string,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, true);
    },
    credentials: true,
  },
})
export class ProfileChatGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(ProfileChatGateway.name);

  @WebSocketServer()
  server?: Server;

  /**
   * Sockets THIS instance holds, so it knows whose TTL to push out.
   *
   * Not the source of truth for who is online — Redis is. This is only the
   * list of keys this process is responsible for keeping alive; another
   * instance keeps its own, and neither can see the other's, which is exactly
   * why the answer lives in Redis rather than here.
   */
  private readonly local = new Map<string, string>();
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly presence: PresenceService,
  ) {}

  handleConnection(client: Socket): void {
    const profileId = this.resolveProfileId(client);

    if (!profileId) {
      this.logger.debug(`Messaging client ${client.id} rejected`);
      client.disconnect(true);
      return;
    }

    void client.join(`profile:${profileId}`);
    this.local.set(client.id, profileId);
    void this.presence.connected(profileId, client.id);
    this.startRefresh();
  }

  handleDisconnect(client: Socket): void {
    const profileId = this.local.get(client.id);
    if (!profileId) return;
    this.local.delete(client.id);
    void this.presence.disconnected(profileId, client.id);
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /**
   * Started lazily and never stopped.
   *
   * A timer created at boot would run in the queue worker and in every spec
   * that instantiates this class, holding the process open. Starting it on the
   * first real connection means it only exists where sockets do.
   */
  private startRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.presence.refresh([...new Set(this.local.values())]);
    }, PRESENCE_REFRESH_MS);
    // Never the reason node stays alive.
    this.refreshTimer.unref?.();
  }

  /**
   * @param message MUST already be the recipient's view — redacted body, no
   *   offsets. This gateway does no filtering of its own; handing it the
   *   author's view would push the withheld characters straight down the wire
   *   and undo everything the controller did.
   */
  emitMessage(profileId: string, message: MessageView): void {
    // No server outside the HTTP app (the queue worker, specs).
    this.server?.to(`profile:${profileId}`).emit('message:new', message);
  }

  /** The other side read the thread — lets the sender's ticks update live. */
  emitRead(profileId: string, conversationId: string): void {
    this.server
      ?.to(`profile:${profileId}`)
      .emit('message:read', { conversationId });
  }

  private resolveProfileId(client: Socket): string | null {
    const token = this.extractToken(client);
    if (!token) return null;

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Admins have their own namespaces; a staff token must not land in a
      // profile room and receive two users' private messages.
      if ((payload.type ?? 'profile') !== 'profile') return null;

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
