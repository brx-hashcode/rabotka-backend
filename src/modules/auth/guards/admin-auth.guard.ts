import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { JwtAuthGuard, AuthenticatedRequest } from './jwt-auth.guard';

/**
 * A valid admin token, from an account that still exists and is still active.
 *
 * The `is_active` check lives here rather than in `RolesGuard` because not
 * every admin route mounts `RolesGuard`. `GET log/admin` and seven
 * `auth/admin/*` routes — including `PATCH admin/me` and TOTP enable/disable —
 * carried this guard alone, so a deactivated admin holding a non-expired token
 * kept full access to them until it expired. Deactivation has to mean
 * deactivated on the next request, everywhere.
 *
 * The row is stashed on the request so `RolesGuard` can reuse it instead of
 * issuing the same query again; on a route with both guards this is one read,
 * as before.
 */
@Injectable()
export class AdminAuthGuard extends JwtAuthGuard {
  constructor(
    jwtService: JwtService,
    configService: ConfigService,
    reflector: Reflector,
    @Inject(REDIS_CONNECTION) redis: Redis,
    private readonly prisma: PrismaService,
  ) {
    super(jwtService, configService, reflector, redis);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isValid = await super.canActivate(context);
    if (!isValid) {
      return false;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (request.user.type !== 'admin') {
      throw new UnauthorizedException('Accès administrateur requis');
    }

    const userId = request.user.userId;

    if (!userId) {
      throw new UnauthorizedException(
        "Token d'authentification administrateur invalide",
      );
    }

    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, is_active: true },
    });

    // Same message and status for "no such account" and "deactivated": which of
    // the two it is, is not something an unauthenticated caller needs to learn.
    if (!account || !account.is_active) {
      throw new UnauthorizedException('Accès administrateur requis');
    }

    request.adminAccount = { role: account.role, isActive: account.is_active };

    return true;
  }
}
