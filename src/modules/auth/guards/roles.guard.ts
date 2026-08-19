import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedRequest } from './jwt-auth.guard';
import {
  isLateralRole,
  lateralRoleCanAccess,
  type LateralRole,
} from './lateral-access';
import { ROLE_HIERARCHY } from '../role-seniority';

/**
 * The highest gate each lateral role may pass INSIDE an area it owns.
 *
 * Two different roles, two different ceilings, because they are two different
 * jobs:
 *
 * - SUPPORT operates the platform, so it needs MANAGER-level actions and
 *   nothing above. Permanent deletion and money movement stay out of reach even
 *   in the areas it fully owns — the ceiling is what enforces that, not the
 *   area map, so widening the map does not widen these.
 * - FINANCE sits at ADMIN, because FINANCE *is* ADMIN minus team management.
 *   Anything an ADMIN may do, it may do in the areas it owns; anything gated at
 *   SUPER_ADMIN (permanent purge, settings) is closed to both alike.
 *
 * The single difference between the two roles therefore lives in
 * `LATERAL_ACCESS`, which withholds `user` from FINANCE — not here.
 */
const LATERAL_CEILING: Record<LateralRole, number> = {
  [UserRole.SUPPORT]: ROLE_HIERARCHY[UserRole.MANAGER],
  [UserRole.FINANCE]: ROLE_HIERARCHY[UserRole.ADMIN],
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const userId = request.user?.userId;

    if (!userId) {
      throw new ForbiddenException('Accès refusé');
    }

    // `AdminAuthGuard` runs first on every admin route and has already read
    // this row; reuse it rather than issuing the same query twice per request.
    // The fallback covers the routes that mount `RolesGuard` behind a different
    // authentication guard.
    const user =
      request.adminAccount ??
      (await this.prisma.user
        .findUnique({
          where: { id: userId },
          select: { role: true, is_active: true },
        })
        .then((row) =>
          row ? { role: row.role, isActive: row.is_active } : null,
        ));

    if (!user?.isActive) {
      throw new ForbiddenException('Accès refusé');
    }

    // Checked BEFORE the "no @Roles means public to admins" shortcut below: an
    // endpoint that simply forgot to declare a role must not become a hole
    // through which a lateral role reaches an area it does not own.
    if (isLateralRole(user.role)) {
      return this.checkLateral(context, user.role, requiredRoles);
    }

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const userLevel = ROLE_HIERARCHY[user.role];
    const requiredLevel = this.requiredLevel(requiredRoles);

    if (userLevel >= requiredLevel) {
      return true;
    }

    throw new ForbiddenException(
      "Vous n'avez pas les permissions nécessaires pour cette action",
    );
  }

  /**
   * Lateral roles are allowed only inside the areas they own, and only up to
   * their own ceiling within them — see `LATERAL_CEILING`.
   */
  private checkLateral(
    context: ExecutionContext,
    role: LateralRole,
    requiredRoles: UserRole[] | undefined,
  ): boolean {
    if (
      requiredRoles?.length &&
      this.requiredLevel(requiredRoles) > LATERAL_CEILING[role]
    ) {
      throw new ForbiddenException(
        "Vous n'avez pas les permissions nécessaires pour cette action",
      );
    }

    const controllerPath =
      (Reflect.getMetadata('path', context.getClass()) as string | undefined) ??
      '';
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (lateralRoleCanAccess(role, controllerPath, request.method)) {
      return true;
    }

    throw new ForbiddenException(
      "Vous n'avez pas les permissions nécessaires pour cette action",
    );
  }

  /** The most permissive of the declared roles wins, as before. */
  private requiredLevel(requiredRoles: UserRole[]): number {
    const levels = requiredRoles
      .filter((r): r is Exclude<UserRole, LateralRole> => !isLateralRole(r))
      .map((r) => ROLE_HIERARCHY[r]);
    // A handler declaring only lateral roles has no ladder meaning; treat it as
    // unreachable by seniority rather than accidentally open to everyone.
    return levels.length > 0 ? Math.min(...levels) : Number.POSITIVE_INFINITY;
  }
}
