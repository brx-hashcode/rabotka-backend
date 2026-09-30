/**
 * Which browser origins may open a Socket.IO connection.
 *
 * Every gateway answered its CORS check with `callback(null, true)` — any
 * origin, and most of them with `credentials: true`. The session cookie is
 * `SameSite=None` in production, so a page on any other site could open the
 * admin chat or notification socket as whoever was signed in, and read it.
 *
 * The list is `ALLOW_ORIGINS`, the same one the HTTP API already answers CORS
 * from, so there is one place to add a front end.
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
    allowed: parseAllowedOrigins(process.env.ALLOW_ORIGINS),
    isProduction: process.env.NODE_ENV === 'production',
  });
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
