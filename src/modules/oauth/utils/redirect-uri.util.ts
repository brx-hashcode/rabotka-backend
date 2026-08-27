/**
 * Whether a requested redirect URI is one this app registered.
 *
 * Exact string equality, deliberately — no normalisation, no case folding, no
 * "ignore the trailing slash", no prefix match. Every convenience anyone has
 * ever added here has turned out to be exploitable: a prefix match lets
 * `https://partner.com/cb` accept `https://partner.com/cb.attacker.com`, and
 * normalising the path lets `/cb/../../open-redirect` through. RFC 9700 §4.1.3
 * is unambiguous: "authorization servers MUST utilize exact string matching".
 *
 * The cost is that a partner who registers `https://x.com/cb` and sends
 * `https://x.com/cb/` gets an error page. That is the correct trade, and the
 * error page says exactly which string was expected.
 */
export function isRegisteredRedirectUri(
  requested: string,
  registered: readonly string[],
): boolean {
  if (typeof requested !== 'string' || requested.length === 0) return false;
  return registered.includes(requested);
}

/**
 * Whether a URI is acceptable to REGISTER in the first place.
 *
 * Registration is an admin action, so this is not a security boundary in the
 * way the check above is — it is here to catch the mistakes that would
 * otherwise be discovered by a partner at 2am: a fragment (which the browser
 * strips, so the URI can never match), a wildcard someone assumed we support,
 * or plaintext HTTP on a public host.
 */
export function validateRedirectUriForRegistration(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "L'URI de redirection doit être une URL absolue.";
  }

  if (url.hash) {
    // The browser never sends a fragment to the server, so a registered URI
    // carrying one can never be matched by an incoming request.
    return "L'URI de redirection ne peut pas contenir de fragment (#).";
  }

  if (raw.includes('*')) {
    return 'Les jokers ne sont pas acceptés : chaque URI de redirection doit être écrite en toutes lettres.';
  }

  const isLoopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';

  // http:// is allowed on loopback and nowhere else. Native and local
  // development genuinely need it; a public http endpoint would put the
  // authorization code on the wire in clear text.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    if (url.protocol === 'http:') {
      return 'HTTP est réservé à localhost. Utilisez HTTPS.';
    }
    // Custom schemes (myapp://) are how native apps receive the redirect, and
    // are explicitly permitted by RFC 8252.
    if (!url.protocol.endsWith(':') || url.protocol.startsWith('javascript')) {
      return 'Schéma de redirection non autorisé.';
    }
  }

  return null;
}
