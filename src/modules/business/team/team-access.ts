import type { BusinessMemberRole } from '@prisma/client';

/**
 * What a team member may call, by role. Decided here, on the route the API
 * matched (`/job-offers/:id/close`, without `/api/v1`), rather than by a
 * decorator on each controller: the business space also uses shared routes
 * (offers, applications, messages, missions) that serve the other apps too.
 *
 * - Reading is open to every role, but for the money and the papers.
 * - An Évaluateur changes nothing but its notes, opinions and own settings:
 *   a route added later is refused to it until listed here.
 * - A Recruteur does the hiring; the plan, payments, the organisation, its
 *   careers page and the team stay with the Administrateurs.
 *
 * The account holder (no member in the token) is not checked: it is the
 * business itself.
 */

/** Reads only an Administrateur makes: invoices, payment links, the papers. */
const ADMIN_READS: RegExp[] = [
  /^\/invoices(\/|$)/,
  /^\/pay\//,
  /^\/business\/me\/documents\//,
];

/** Changes only an Administrateur makes. */
const ADMIN_CHANGES: RegExp[] = [
  /^\/business\/me$/,
  /^\/business\/me\/documents(\/|$)/,
  /^\/business\/me\/subscription(\/|$)/,
  /^\/business\/me\/careers-page(\/|$)/,
  /^\/business\/me\/interviews\/calendar\/reset$/,
  /^\/business\/me\/team(\/|$)/,
  /^\/(pay|payments|wallet|invoices)(\/|$)/,
  // The profile is the organisation's account (logo, papers, settings); a
  // Recruteur reaches it only through hiring.
  /^\/profile(?!\/(job-offers|applications|notifications|claims)(\/|$))(\/|$)/,
];

/** The changes an Évaluateur may make. */
const REVIEWER_CHANGES: RegExp[] = [
  /^\/business\/me\/applications\/[^/]+\/[^/]+\/(notes|opinion)(\/|$)/,
  /^\/business\/me\/member$/,
  /^\/profile\/notifications(\/|$)/,
  /^\/profile\/claims(\/|$)/,
  /^\/auth\//,
];

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function memberMayCall(
  role: BusinessMemberRole,
  method: string,
  path: string,
): boolean {
  if (role === 'ADMIN') return true;
  const reading = READS.has(method.toUpperCase());
  if (reading) return !ADMIN_READS.some((r) => r.test(path));
  // Every member signs out, and manages its own e-mails and notifications.
  if (REVIEWER_CHANGES.some((r) => r.test(path))) return true;
  if (role === 'REVIEWER') return false;
  return !ADMIN_CHANGES.some((r) => r.test(path));
}

/** Why a member was refused, in the space's words. */
export function refusalFor(role: BusinessMemberRole): string {
  return role === 'REVIEWER'
    ? 'En tant qu’évaluateur, vous pouvez consulter les candidats et donner votre avis, pas modifier.'
    : 'Réservé aux administrateurs de votre organisation.';
}

/** The route as the API matched it, without the global prefix. */
export function routePattern(req: {
  route?: { path?: string };
  baseUrl?: string;
  path?: string;
}): string {
  const raw = req.route?.path
    ? `${req.baseUrl ?? ''}${req.route.path}`
    : (req.path ?? '');
  const path = raw.replace(/^\/api\/v1/, '') || '/';
  return path.length > 1 ? path.replace(/\/$/, '') : path;
}
