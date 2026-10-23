import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { isBusinessEmployer } from '../../business/business-rules';
import { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * The business dashboard's routes: only an employer flagged `is_business`
 * with a live organisation. Composed after ProfileAuthGuard, and read fresh
 * on every request like ActiveProfileGuard — unflagging or archiving takes
 * effect on the next call, not when a token expires.
 */
@Injectable()
export class BusinessProfileGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

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
        business: { select: { deleted_at: true } },
      },
    });
    if (!profile || !isBusinessEmployer(profile)) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    return true;
  }
}
