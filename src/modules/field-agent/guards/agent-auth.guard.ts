import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AgentStatus } from '@prisma/client';
import type { Request } from 'express';
import Redis from 'ioredis';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import type { JwtPayload } from '../../auth/guards/jwt-auth.guard';
import { isSessionRevoked } from '../../auth/session-revocation';

export interface AgentAuthenticatedRequest extends Request {
  agent: { agentId: string };
}

/**
 * The agent app's only door.
 *
 * Standalone rather than a JwtAuthGuard subclass, for two reasons.
 *
 * BEARER ONLY. JwtAuthGuard reads the session COOKIE first. An agent who is
 * also a worker, logged into the worker web app in the same browser, would send
 * that profile cookie along with the agent app's requests — and the cookie
 * would win over the agent's bearer token. Reading the header alone means the
 * identity on an agent route is always the agent's.
 *
 * ITS OWN TYPE. JwtAuthGuard refuses `agent` tokens outright, so that no
 * profile or admin route can be reached with one; this guard accepts nothing
 * else.
 *
 * The status is re-read on every request, uncached, like ActiveProfileGuard:
 * a suspended agent is locked out on their next call, not when their token
 * happens to expire.
 */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AgentAuthenticatedRequest>();

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentification requise');
    }

    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(header.slice(7), {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Session invalide ou expirée');
    }

    if (payload.type !== 'agent' || !payload.sub) {
      throw new UnauthorizedException('Session agent requise');
    }

    if (await isSessionRevoked(this.redis, payload.jti)) {
      throw new UnauthorizedException('Session invalide ou expirée');
    }

    const agent = await this.prisma.agent.findUnique({
      where: { id: payload.sub },
      select: { status: true },
    });
    if (!agent) {
      throw new UnauthorizedException('Session invalide ou expirée');
    }
    if (agent.status !== AgentStatus.ACTIVE) {
      throw new ForbiddenException(
        agent.status === AgentStatus.SUSPENDED
          ? 'Votre compte agent est suspendu.'
          : "Votre compte agent n'est plus actif.",
      );
    }

    request.agent = { agentId: payload.sub };
    return true;
  }
}
