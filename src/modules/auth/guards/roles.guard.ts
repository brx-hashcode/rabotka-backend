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

/**
 * Seniority ladder. Lateral roles are deliberately absent — they are not more
 * or less senior than a MODERATOR, they simply cover a different area, and
 * giving them a number here would silently grant them every endpoint at or
 * below that number.
 */
const ROLE_HIERARCHY: Record<Exclude<UserRole, LateralRole>, number> = {
  [UserRole.MODERATOR]: 1,
  [UserRole.MANAGER]: 2,
  [UserRole.ADMIN]: 3,
  [UserRole.SUPER_ADMIN]: 4,
};

/**
 * The highest gate a lateral role may pass inside an area it owns. ADMIN- and
 * SUPER_ADMIN-gated actions (permanent deletion, team management) stay out of
 * reach even where the area itself is allowed.
 */
const MAX_LATERAL_LEVEL = ROLE_HIERARCHY[UserRole.MANAGER];

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

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, is_active: true },
    });

    if (!user || !user.is_active) {
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
   * MANAGER-level actions within them.
   */
  private checkLateral(
    context: ExecutionContext,
    role: LateralRole,
    requiredRoles: UserRole[] | undefined,
  ): boolean {
    if (requiredRoles?.length && this.requiredLevel(requiredRoles) > MAX_LATERAL_LEVEL) {
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
