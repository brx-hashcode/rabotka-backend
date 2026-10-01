import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { isSessionRevoked } from '../auth/session-revocation';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { socketCorsOrigin } from '../../common/utils/allowed-origins';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import type { JwtPayload } from '../auth/guards/jwt-auth.guard';

/**
 * Live comments on one claim, for the admin working it and the profile who
 * raised it.
 *
 * Joining a claim's room used to need nothing but its id: no token was read,
 * so anyone who learned an id received every comment written on that claim
 * from then on. The room is now joined only by an active admin, or by the
 * profile the claim belongs to — the same two audiences the HTTP routes serve.
 *
 * A refused join is silent. The socket is only an optimisation here: the
 * comment list is fetched over HTTP, which is where a caller is told no.
 */
@WebSocketGateway({
  namespace: '/claim-comments',
  cors: {
    origin: socketCorsOrigin,
    credentials: true,
  },
})
export class ClaimCommentsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ClaimCommentsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  handleConnection(client: Socket): void {
    this.logger.debug(`Claim comments client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Claim comments client disconnected: ${client.id}`);
  }

  @SubscribeMessage('join-claim')
  async handleJoinClaim(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { claimId: string },
  ): Promise<void> {
    const claimId = data?.claimId;
    if (typeof claimId !== 'string' || claimId.length === 0) return;

    if (!(await this.mayRead(client, claimId))) {
      this.logger.debug(`Client ${client.id} refused room claim:${claimId}`);
      return;
    }

    const room = `claim:${claimId}`;
    void client.join(room);
    this.logger.debug(`Client ${client.id} joined room ${room}`);
  }

  emitNewComment(claimId: string, comment: Record<string, unknown>): void {
    this.server.to(`claim:${claimId}`).emit('comment:new', comment);
  }

  emitDeletedComment(claimId: string, commentId: string): void {
    this.server.to(`claim:${claimId}`).emit('comment:deleted', { commentId });
  }

  private async mayRead(client: Socket, claimId: string): Promise<boolean> {
    const payload = this.verify(client);
    if (!payload?.sub) return false;

    try {
      if (await isSessionRevoked(this.redis, payload.jti)) return false;

      if (payload.type === 'admin') {
        const admin = await this.prisma.user.findUnique({
          where: { id: payload.sub },
          select: { is_active: true },
        });
        return admin?.is_active === true;
      }

      // Same default as `JwtAuthGuard`: a token with no type is a profile's.
      if ((payload.type ?? 'profile') !== 'profile') return false;

      const claim = await this.prisma.claim.findUnique({
        where: { id: claimId },
        select: { profile_id: true },
      });
      return claim?.profile_id === payload.sub;
    } catch {
      // A malformed id or a database hiccup is a refusal, not a crash.
      return false;
    }
  }

  /** The session token off the handshake: `auth.token`, else the cookie. */
  private verify(client: Socket): JwtPayload | null {
    const token = this.extractToken(client);
    if (!token) return null;

    try {
      return this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      return null;
    }
  }

  private extractToken(client: Socket): string | undefined {
    const authToken: unknown = client.handshake?.auth?.token;
    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken;
    }

    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');
    const cookieHeader = client.handshake?.headers?.cookie;
    if (!cookieName || !cookieHeader) return undefined;

    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === cookieName) {
        try {
          return decodeURIComponent(rest.join('='));
        } catch {
          return undefined;
        }
      }
    }

    return undefined;
  }
}
