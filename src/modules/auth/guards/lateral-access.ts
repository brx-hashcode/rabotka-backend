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
    // WhatsApp is a real line item on the Meta invoice, so finance needs the
    // consumption figures. Read only: the delivery log carries message bodies
    // and recipient numbers, and retrying a dead-lettered send is an
    // operational act, not a financial one.
    'admin/whatsapp': 'read',
  },
  [UserRole.SUPPORT]: {
    'admin/claims': 'full',
    'admin/chat': 'full',
    'admin/profiles': 'read',
    'admin/applications': 'read',
    'admin/job-offers': 'read',
    // "Did the customer get the message?" is the first question on half of all
    // support tickets, and until now nobody could answer it.
    'admin/whatsapp': 'read',
    // Post-unlock sentiment is context for the claim sitting next to it. Read
    // only: the feedback rows carry the author's name and phone, and support's
    // reach into personal data stays at the same level as `admin/profiles`.
    'admin/feedback': 'read',
    // The paperwork behind a claim. "What did they actually agree to?" is
    // unanswerable without the signed contract, and escalating to a manager to
    // read a PDF is the kind of hop that makes support slower than the problem.
    // Read only, and both are download-by-id — there is no listing to browse.
    'admin/contracts': 'read',
    'admin/invoices': 'read',
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
