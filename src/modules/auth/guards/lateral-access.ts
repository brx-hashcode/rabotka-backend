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
  // Finance is broad here, not narrow: everything an admin can reach EXCEPT
  // team management and settings. That is a deliberate product decision, so the
  // map is written as "all areas minus two" rather than a short allowlist.
  //
  // Note what this does NOT grant. `RolesGuard` caps every lateral role at
  // MANAGER level whatever is written here, so ADMIN- and SUPER_ADMIN-gated
  // handlers inside these areas stay closed — permanent purge, and crediting a
  // wallet from a profile.
  [UserRole.FINANCE]: {
    'admin/wallet': 'full',
    'admin/payment-requests': 'full',
    'admin/penalties': 'full',
    'admin/profiles': 'full',
    'admin/job-offers': 'full',
    'admin/applications': 'full',
    'admin/job-categories': 'full',
    'admin/claims': 'full',
    'admin/chat': 'full',
    'admin/event': 'full',
    'admin/documents': 'full',
    'admin/advertisements': 'full',
    'admin/whatsapp': 'full',
    // `full` throughout, including these — several expose only GETs today
    // (dashboard, collaboration graph, feedback, the two download endpoints,
    // the audit log), so `full` and `read` behave identically for them. It is
    // written as `full` anyway so the map states the policy rather than an
    // accident of which verbs those controllers happen to implement.
    'admin/dashboard': 'full',
    'admin/collaboration-graph': 'full',
    'admin/feedback': 'full',
    'admin/invoices': 'full',
    'admin/contracts': 'full',
    log: 'full',
    // NOT PRESENT, deliberately: `user` (team management) and
    // `admin/system-configs` (settings). Anything absent is denied, so leaving
    // them out is the whole of the restriction.
  },
  // Support is not a narrow badge here — it is the team that runs the platform
  // day to day. `read` on profiles meant they could open a profile and not
  // verify it, which is the single thing they are most often asked to do.
  //
  // `full` is safe to hand out because `RolesGuard` caps every lateral role at
  // MANAGER level regardless of this map: bulk purge (SUPER_ADMIN) and
  // crediting a wallet (ADMIN) stay out of reach without being named here.
  [UserRole.SUPPORT]: {
    'admin/claims': 'full',
    'admin/chat': 'full',
    'admin/profiles': 'full',
    'admin/applications': 'full',
    'admin/job-offers': 'full',
    // Disputes over a penalty are support's, including confirming that one was
    // paid. Creating and cancelling them are MANAGER-level and stay reachable;
    // permanent deletion is not.
    'admin/penalties': 'full',
    // The landing page, readable by every role — see the note on FINANCE above.
    // Without it, support lands on a page of empty charts while the tables
    // underneath fill in from `admin/profiles`.
    'admin/dashboard': 'read',
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
