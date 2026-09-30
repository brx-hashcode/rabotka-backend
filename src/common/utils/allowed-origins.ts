/**
 * Which browser origins may open a Socket.IO connection.
 *
 * Every gateway answered its CORS check with `callback(null, true)` — any
 * origin, and most of them with `credentials: true`. The session cookie is
 * `SameSite=None` in production, so a page on any other site could open the
 * admin chat or notification socket as whoever was signed in, and read it.
 *
 * The list is `ALLOW_ORIGINS`, the same one the HTTP API already answers CORS
 * from, plus the two front ends the backend is told about by name.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => normaliseOrigin(origin))
    .filter(Boolean);
}

export function isOriginAllowed(
  origin: string | undefined,
  options: { allowed: readonly string[]; isProduction: boolean },
): boolean {
  // No Origin header is not a browser: the mobile app, a server, curl. CORS
  // and cross-site cookies are browser mechanics, so there is nothing here to
  // protect against — those clients authenticate with a token in the handshake.
  if (!origin) return true;

  const normalised = normaliseOrigin(origin);
  if (options.allowed.includes(normalised)) return true;

  // Outside production, a dev server on any local port. Front ends are run
  // behind a proxy on ports nobody lists (the admin on 3200, a preview on
  // 3201), and refusing them would only teach people to disable the check.
  return !options.isProduction && isLoopbackOrigin(normalised);
}

/**
 * The `cors.origin` callback for a gateway, and the adapter's handshake check.
 *
 * Reads the environment on each call rather than at import: gateway decorators
 * are evaluated when the file is loaded, which is before ConfigModule has
 * copied `.env` into `process.env`.
 */
export function socketOriginAllowed(origin: string | undefined): boolean {
  return isOriginAllowed(origin, {
    allowed: knownOrigins(process.env),
    isProduction: process.env.NODE_ENV === 'production',
  });
}

/**
 * `ALLOW_ORIGINS`, and the origins of `FRONTEND_URL` and `ADMIN_BASE_URL`.
 *
 * The two urls are included because `ALLOW_ORIGINS` need not name our own
 * front ends at all: the admin reaches the API through a same-origin reverse
 * proxy (`/api/v1`), which needs no CORS entry and so may never have been given
 * one. Its socket still arrives with the admin's Origin, and refusing it would
 * take the admin's live updates down on deploy.
 */
export function knownOrigins(env: {
  ALLOW_ORIGINS?: string;
  FRONTEND_URL?: string;
  ADMIN_BASE_URL?: string;
}): string[] {
  const origins = new Set(parseAllowedOrigins(env.ALLOW_ORIGINS));
  for (const url of [env.FRONTEND_URL, env.ADMIN_BASE_URL]) {
    const origin = originOf(url);
    if (origin) origins.add(origin);
  }
  return [...origins];
}

function originOf(url: string | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const { origin } = new URL(url.trim());
    // An opaque origin serialises as the string "null".
    return origin === 'null' ? null : normaliseOrigin(origin);
  } catch {
    return null;
  }
}

export function socketCorsOrigin(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  callback(null, socketOriginAllowed(origin));
}

function normaliseOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
}
