import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import type { JwtPayload } from '../../auth/guards/jwt-auth.guard';

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
    origin: (
      _origin: string,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, true);
    },
    credentials: true,
  },
})
export class AdInboxGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AdInboxGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  handleConnection(client: Socket): void {
    const profileId = this.resolveProfileId(client);

    if (!profileId) {
      this.logger.debug(`Ad inbox client ${client.id} rejected: no profile token`);
      client.disconnect(true);
      return;
    }

    void client.join(`profile:${profileId}`);
    this.logger.debug(`Ad inbox client ${client.id} joined profile:${profileId}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Ad inbox client disconnected: ${client.id}`);
  }

  emitNewAd(profileId: string, ad: InAppAdPayload): void {
    this.server.to(`profile:${profileId}`).emit('ad:new', ad);
  }

  /** Reads the auth cookie (or `auth.token`) off the handshake and verifies it. */
  private resolveProfileId(client: Socket): string | null {
    const token = this.extractToken(client);
    if (!token) return null;

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Admins have no ad inbox — only profile tokens map to a room.
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
