import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { isLateralRole, type LateralRole } from './guards/lateral-access';

/**
 * Seniority ladder. Lateral roles are deliberately absent — they are not more
 * or less senior than a MODERATOR, they simply cover a different area, and
 * giving them a number here would silently grant them every endpoint at or
 * below that number.
 *
 * This lives outside `roles.guard.ts` so that route authorization and team
 * management read the same ladder. They did not: the guard let an ADMIN through
 * to `PATCH /user/:id`, and the service then wrote whatever `role` the body
 * carried — including SUPER_ADMIN, to their own account.
 */
export const ROLE_HIERARCHY: Record<Exclude<UserRole, LateralRole>, number> = {
  [UserRole.MODERATOR]: 1,
  [UserRole.MANAGER]: 2,
  [UserRole.ADMIN]: 3,
  [UserRole.SUPER_ADMIN]: 4,
};

/** The level a lateral role is treated as when it is the SUBJECT of an action. */
const LATERAL_TARGET_LEVEL = ROLE_HIERARCHY[UserRole.ADMIN];

/**
 * The ladder level of any role, for comparison purposes.
 *
 * A lateral role has no rung, so as a *target* it is treated as ADMIN-level:
 * granting or revoking one is an ADMIN decision, not something a MANAGER may do
 * on the way past. As an *actor* it never reaches here at all — `user` is in no
 * lateral allowlist, so `RolesGuard` has already refused.
 */
function levelOf(role: UserRole): number {
  return isLateralRole(role) ? LATERAL_TARGET_LEVEL : ROLE_HIERARCHY[role];
}

/** Whether `actor` is at least as senior as `other`. */
export function outranksOrEquals(actor: UserRole, other: UserRole): boolean {
  return levelOf(actor) >= levelOf(other);
}

/**
 * The two invariants of team management, in one place.
 *
 * 1. You may not act on somebody senior to you.
 * 2. You may not hand out a role senior to your own.
 *
 * Without the second, the first is decoration: an ADMIN could simply promote
 * themselves to SUPER_ADMIN and then act on anyone. Both are checked on the
 * server because the admin UI's role picker is a convenience, not a control.
 */
export function assertCanManageUser(
  actorRole: UserRole,
  targetRole: UserRole,
): void {
  if (!outranksOrEquals(actorRole, targetRole)) {
    throw new ForbiddenException(
      'Vous ne pouvez pas gérer un compte plus élevé que le vôtre',
    );
  }
}

export function assertCanAssignRole(
  actorRole: UserRole,
  newRole: UserRole,
): void {
  if (!outranksOrEquals(actorRole, newRole)) {
    throw new ForbiddenException(
      'Vous ne pouvez pas attribuer un rôle plus élevé que le vôtre',
    );
  }
}
