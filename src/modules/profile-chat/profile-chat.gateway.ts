import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import type { MessageView } from './profile-chat.service';

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
export class ProfileChatGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ProfileChatGateway.name);

  @WebSocketServer()
  server?: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  handleConnection(client: Socket): void {
    const profileId = this.resolveProfileId(client);

    if (!profileId) {
      this.logger.debug(`Messaging client ${client.id} rejected`);
      client.disconnect(true);
      return;
    }

    void client.join(`profile:${profileId}`);
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
