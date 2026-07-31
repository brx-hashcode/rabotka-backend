import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { assertKycVerified } from '../../../common/exceptions/kyc-not-verified.exception';
import { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Refuses an action unless the acting profile has passed KYC.
 *
 * Composed with ProfileAuthGuard rather than extending it —
 * `@UseGuards(ProfileAuthGuard, KycVerifiedGuard)`. Nest runs guards in order,
 * so `request.user.profileId` is already populated by the time this runs, and
 * staying standalone means the only dependency is PrismaService (a @Global
 * provider), so no consumer needs module wiring.
 *
 * Apply per HANDLER, never to a whole controller: gating the GETs too would
 * stop an unverified user from even browsing, which is not the intent.
 */
@Injectable()
export class KycVerifiedGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const profileId = request.user?.profileId;

    if (!profileId) {
      throw new ForbiddenException('Accès refusé');
    }

    // One indexed PK read. Every handler behind this guard already runs the
    // same lookup for its profile-type check, so this is noise — and caching it
    // would risk telling a freshly approved user they are still pending.
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { verification_status: true },
    });

    if (!profile) {
      throw new ForbiddenException('Profil introuvable');
    }

    assertKycVerified(profile.verification_status);
    return true;
  }
}
