import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { assertAccountActive } from '../../../common/exceptions/account-not-active.exception';
import { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * Refuses an action unless the acting profile's account is ACTIVE.
 *
 * This exists because suspension had no effect on a session that already
 * existed. `JwtAuthGuard` validates the token and nothing re-reads the profile,
 * so a user suspended at 10am kept full privileges — including spending wallet
 * credit to unlock a contact — until their token expired. Only the WhatsApp
 * magic-link path ever checked, and it checks at login rather than per request.
 *
 * Sign-in is deliberately still allowed: a suspended user must be able to open
 * the app, see why, and reach support. Everything they could DO is what this
 * guard takes away.
 *
 * Composed with ProfileAuthGuard rather than extending it —
 * `@UseGuards(ProfileAuthGuard, ActiveProfileGuard)`. Nest runs guards in
 * order, so `request.user.profileId` is already populated by the time this
 * runs, and staying standalone means the only dependency is PrismaService (a
 * @Global provider), so no consumer needs module wiring.
 *
 * Apply per HANDLER, never to a whole controller — exactly as `KycVerifiedGuard`
 * is applied, and for the same reason: gating the GETs would stop a suspended
 * user from seeing their own status, which is the opposite of the intent.
 */
@Injectable()
export class ActiveProfileGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const profileId = request.user?.profileId;

    if (!profileId) {
      throw new ForbiddenException('Accès refusé');
    }

    // One indexed PK read, uncached on purpose: caching it would keep acting on
    // a suspension for as long as the TTL, which is the bug this guard fixes.
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { status: true, suspension_reason: true },
    });

    if (!profile) {
      throw new ForbiddenException('Profil introuvable');
    }

    assertAccountActive(profile.status, profile.suspension_reason);
    return true;
  }
}
