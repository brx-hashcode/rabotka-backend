import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { assertAccountNotBlocked } from '../../../common/exceptions/account-not-active.exception';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { isBusinessEmployer } from '../../business/business-rules';
import { OPEN_TO_BLOCKED_BUSINESS_KEY } from '../decorators/open-to-blocked-business.decorator';
import { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * The business dashboard's routes: only an employer flagged `is_business`
 * with a live organisation. Composed after ProfileAuthGuard, and read fresh
 * on every request like ActiveProfileGuard — unflagging or archiving takes
 * effect on the next call, not when a token expires.
 *
 * A SUSPENDED or BANNED business (and so its whole team) may still read its
 * space, but makes no write: no contact, no message, no invitation, no
 * purchase. Each handler used to have to opt in to a status check, and the
 * business routes never did. A pending business still passes: it has to
 * complete its file. `@OpenToBlockedBusiness()` keeps a write open.
 */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class BusinessProfileGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector = new Reflector(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const profileId = request.user?.profileId;
    if (!profileId) {
      throw new ForbiddenException('Accès refusé');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        profile_type: true,
        is_business: true,
        deleted_at: true,
        status: true,
        suspension_reason: true,
        business: { select: { deleted_at: true } },
      },
    });
    if (!profile || !isBusinessEmployer(profile)) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    if (
      !READS.has(request.method?.toUpperCase() ?? 'GET') &&
      !this.reflector.getAllAndOverride<boolean>(OPEN_TO_BLOCKED_BUSINESS_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      assertAccountNotBlocked(profile.status, profile.suspension_reason);
    }
    return true;
  }
}
