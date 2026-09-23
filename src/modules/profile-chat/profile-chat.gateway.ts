import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  Logger,
  OnModuleDestroy,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';
import type { MessageView } from './profile-chat.service';
import { PresenceService } from './presence.service';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { TypingDto } from './dto/profile-chat.dto';

/** Well under the 90s TTL, so one missed tick never drops somebody offline. */
const PRESENCE_REFRESH_MS = 45_000;

/**
 * The floor between two `typing` events from one socket.
 *
 * The client already throttles; this is the copy that matters, because the
 * client is not the one that has to be trusted.
 */
const TYPING_MIN_INTERVAL_MS = 2_000;

/**
 * How long a verified membership is trusted without asking the database again.
 *
 * Somebody typing steadily emits every few seconds, and none of those is worth
 * a query. A minute is short enough that a conversation closed in the meantime
 * stops relaying almost at once, and the tell is ephemeral either way.
 */
const MEMBERSHIP_TTL_MS = 60_000;

/**
 * Pushes a new message to the recipient's open tabs.
 *
 * ANYTHING THAT IS STORED GOES OVER REST. Sending a message, marking a thread
 * read, deleting one: all of it stays on the controller, where the global
 * `ValidationPipe` and the moderation pass apply. That pipe does NOT run on
 * gateways, which is exactly how `chat.gateway.ts` ended up accepting a socket
 * message body no DTO validates, and an inbound send here would bypass the
 * moderation this whole module exists for.
 *
 * The one exception is `typing` below, and it is allowed only because it meets
 * all four conditions: it persists nothing, it carries a single uuid, that uuid
 * is validated by a pipe applied by hand, and membership is re-checked against
 * the database before anything is relayed. A new inbound handler that cannot
 * say the same of itself belongs on the controller instead.
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

  /**
   * Conversations this instance has already confirmed a profile belongs to,
   * with the counterpart to relay to and when the answer goes stale.
   *
   * Per-instance rather than in Redis on purpose: it holds no secret, a miss
   * costs one indexed lookup, and the entry dies with the process. Bounded by
   * the sockets this instance holds, and swept when they disconnect.
   */
  private readonly membership = new Map<
    string,
    { counterpartId: string; expiresAt: number }
  >();

  /** Last `typing` relayed per socket, for the rate floor. */
  private readonly lastTypingAt = new Map<string, number>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly presence: PresenceService,
    private readonly prisma: PrismaService,
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
    this.lastTypingAt.delete(client.id);
    const profileId = this.local.get(client.id);
    if (!profileId) return;
    this.local.delete(client.id);
    void this.presence.disconnected(profileId, client.id);

    // The membership entries this profile put there are no use to anybody once
    // its last socket is gone.
    if (![...this.local.values()].includes(profileId)) {
      for (const key of this.membership.keys()) {
        if (key.startsWith(`${profileId}:`)) this.membership.delete(key);
      }
    }
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

  /**
   * A message was taken back. Sent to BOTH parties, including the author, who
   * may have the same thread open in another tab.
   *
   * Carries the id and nothing else: the tombstone's shape is the client's
   * business, and there is no longer any content to send.
   */
  emitDeleted(
    profileId: string,
    conversationId: string,
    messageId: string,
  ): void {
    this.server
      ?.to(`profile:${profileId}`)
      .emit('message:deleted', { conversationId, messageId });
  }

  /**
   * "The other person is writing." The module's ONLY inbound handler — see the
   * note at the top of this file for the conditions it had to meet.
   *
   * The pipe is applied by hand because the global one does not run on
   * gateways. The room is derived from the handshake JWT, never from the
   * payload, and membership is confirmed against the database before a single
   * byte is relayed — otherwise this would be a way to learn, one uuid at a
   * time, which conversations exist.
   *
   * There is no `isTyping: false`. The client re-emits while the draft is
   * changing and the receiver expires the indicator on its own timer, which
   * means a dropped event costs a second of staleness instead of leaving three
   * dots bouncing forever.
   */
  @SubscribeMessage('typing')
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: TypingDto,
  ): Promise<void> {
    const profileId = this.local.get(client.id);
    if (!profileId) return;

    const now = Date.now();
    const last = this.lastTypingAt.get(client.id) ?? 0;
    if (now - last < TYPING_MIN_INTERVAL_MS) return;
    this.lastTypingAt.set(client.id, now);

    const counterpartId = await this.counterpartFor(
      dto.conversationId,
      profileId,
    );
    // Silent on refusal. A client that is not in that conversation gets no
    // error to tell it apart from one that is.
    if (!counterpartId) return;

    this.server
      ?.to(`profile:${counterpartId}`)
      .emit('typing', { conversationId: dto.conversationId });
  }

  /**
   * The other party of a conversation this profile actually belongs to, or
   * null. Cached briefly, because somebody typing asks this every few seconds.
   */
  private async counterpartFor(
    conversationId: string,
    profileId: string,
  ): Promise<string | null> {
    const key = `${profileId}:${conversationId}`;
    const cached = this.membership.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.counterpartId;

    const conversation = await this.prisma.profileConversation
      .findFirst({
        where: {
          id: conversationId,
          closed_at: null,
          OR: [{ worker_id: profileId }, { employer_id: profileId }],
        },
        select: { worker_id: true, employer_id: true },
      })
      .catch((error) => {
        this.logger.warn(
          `Could not resolve conversation ${conversationId} for typing`,
          error,
        );
        return null;
      });

    if (!conversation) {
      this.membership.delete(key);
      return null;
    }

    const counterpartId =
      conversation.worker_id === profileId
        ? conversation.employer_id
        : conversation.worker_id;
    this.membership.set(key, {
      counterpartId,
      expiresAt: Date.now() + MEMBERSHIP_TTL_MS,
    });
    return counterpartId;
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
