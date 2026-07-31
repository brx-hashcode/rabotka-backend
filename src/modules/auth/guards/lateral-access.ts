import { UserRole } from '@prisma/client';

/**
 * Roles that sit OUTSIDE the ADMIN/MANAGER/MODERATOR/SUPER_ADMIN ladder.
 *
 * The ladder answers "how senior are you"; these answer "which part of the
 * business are you". There is no number that expresses "can settle a payment
 * but must not moderate a profile", so lateral roles are never compared against
 * ROLE_HIERARCHY — they are matched against the allowlist below instead.
 */
export const LATERAL_ROLES = [UserRole.FINANCE, UserRole.SUPPORT] as const;

export type LateralRole = (typeof LATERAL_ROLES)[number];

export function isLateralRole(role: UserRole): role is LateralRole {
  return (LATERAL_ROLES as readonly UserRole[]).includes(role);
}

/** `read` restricts the area to safe methods; `full` allows writes too. */
export type AreaAccess = 'full' | 'read';

/**
 * What each lateral role may reach, keyed by the controller's own route prefix
 * (the string passed to `@Controller(...)`).
 *
 * Keyed by controller rather than sprinkled as decorators on purpose: this is a
 * security boundary, and a boundary you cannot read in one sitting is a
 * boundary nobody audits. Anything absent from a role's map is denied, so a new
 * admin controller is closed to lateral roles until somebody adds it here
 * deliberately.
 */
export const LATERAL_ACCESS: Record<LateralRole, Record<string, AreaAccess>> = {
  [UserRole.FINANCE]: {
    'admin/wallet': 'full',
    'admin/payment-requests': 'full',
    'admin/penalties': 'full',
    'admin/dashboard': 'full',
    'admin/invoices': 'read',
    // Finance needs to identify who a payment belongs to — not to moderate them.
    'admin/profiles': 'read',
  },
  [UserRole.SUPPORT]: {
    'admin/claims': 'full',
    'admin/chat': 'full',
    'admin/profiles': 'read',
    'admin/applications': 'read',
    'admin/job-offers': 'read',
  },
};

/** HTTP methods that cannot change state, so `read` access permits them. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a lateral role may call this handler.
 *
 * `controllerPath` is the raw `@Controller()` prefix, read off Nest's own route
 * metadata rather than parsed from the URL — the URL would drift the moment a
 * global prefix or a version segment is introduced.
 */
export function lateralRoleCanAccess(
  role: LateralRole,
  controllerPath: string,
  method: string,
): boolean {
  const access = LATERAL_ACCESS[role][normalisePath(controllerPath)];
  if (!access) return false;
  return access === 'full' || SAFE_METHODS.has(method.toUpperCase());
}

function normalisePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}
