/**
 * The routes that are called by something other than Rabotka's own pages, and
 * which the origin check (origin-check.middleware.ts) therefore skips.
 *
 * Each entry is a PATH PREFIX under the global `/api/v1` prefix, matched on a
 * segment boundary. Why each one is here:
 *
 * - `whatsapp/incoming` and `webhooks/whatsapp` — Twilio's and Meta's webhooks.
 *   A provider is not one of our origins, and a 403 from the check means
 *   signature verification never runs and Meta retries against it for days.
 * - `auth/mobile` — the mobile app, which holds no cookie session.
 * - `agent/auth` — the field-agent app's login, for the same reason: it holds
 *   no cookie, and its tokens travel in the body and the Authorization header.
 *   Everything else under `agent/` is Bearer-authenticated, which the
 *   `isBearer` escape already covers.
 * - `oauth/token`, `oauth/revoke`, `oauth/userinfo` — called by a partner's
 *   BACKEND with HTTP Basic client credentials or a bearer token, neither of
 *   which a browser attaches ambiently. `/oauth/interaction/*` is deliberately
 *   NOT listed: Rabotka's own consent page calls those with the session cookie,
 *   which is exactly the shape CSRF exists for.
 * - `identity-checks` — the partner identity-check API, same reasoning. The
 *   person-side routes live under `/profile/identity-checks` and are not
 *   matched.
 * - `client-errors` — sent with `sendBeacon`, which cannot attach the header,
 *   and the endpoint only writes a throttled log line.
 * - `webhooks/payment` — the payment providers' callbacks. These were missing,
 *   so every callback was answered 403 here and never reached its handler. The
 *   polling job covers the first two minutes of a payment; after it gives up
 *   it puts the request back to PENDING precisely so the callback can settle
 *   it, and that callback never arrived — a customer who approved on their
 *   phone after two minutes paid and got nothing. The handlers do not trust
 *   the body: they re-check the payment with the provider before acting.
 */
const CSRF_EXEMPT_PREFIXES = [
  '/api/v1/whatsapp/incoming',
  '/api/v1/webhooks/whatsapp',
  '/api/v1/auth/mobile',
  '/api/v1/agent/auth',
  '/api/v1/oauth/token',
  '/api/v1/oauth/revoke',
  '/api/v1/oauth/userinfo',
  '/api/v1/identity-checks',
  '/api/v1/client-errors',
  '/api/v1/webhooks/payment',
] as const;

/**
 * Whether a request URL is one of the exempt routes.
 *
 * Judged on the PATH alone. This used to be `url.includes(...)` against the
 * full `originalUrl`, query string included, so `?x=/auth/mobile/` appended to
 * any POST switched the protection off for it — on every route in the API.
 */
export function isCsrfExemptPath(url: string): boolean {
  const path = pathOf(url);
  return CSRF_EXEMPT_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  const path = end === -1 ? url : url.slice(0, end);
  // `//api/v1/x` and `/api/v1/x/` reach the same handler as `/api/v1/x`.
  return path.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}
