import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { assertAccountNotBlocked } from '../../../common/exceptions/account-not-active.exception';
import { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Refuses an action from a SUSPENDED or BANNED profile; a pending one passes.
 *
 * `ActiveProfileGuard`'s sibling, for the routes a new account uses while it
 * waits for KYC — editing its profile and portfolio, changing its number,
 * topping up. Those could not take the active guard without breaking
 * onboarding, so they took none, and a suspended account could go on editing
 * its public profile and portfolio as if nothing had happened.
 *
 * Composed and applied exactly like `ActiveProfileGuard`: after
 * `ProfileAuthGuard`, per handler, never on a whole controller.
 */
@Injectable()
export class UnblockedProfileGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const profileId = request.user?.profileId;

    if (!profileId) {
      throw new ForbiddenException('Accès refusé');
    }

    // Uncached, for the reason ActiveProfileGuard gives: a cached status keeps
    // honouring a suspension's absence for as long as the TTL.
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { status: true, suspension_reason: true },
    });

    if (!profile) {
      throw new ForbiddenException('Profil introuvable');
    }

    assertAccountNotBlocked(profile.status, profile.suspension_reason);
    return true;
  }
}
