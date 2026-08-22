/**
 * Reconstructs an R2 object key from a url stored in the database.
 *
 * Its own module so it can be tested without importing the backfill script,
 * which connects to Postgres and runs on import.
 *
 * Two url shapes exist in the data:
 *   - public:  `${publicBaseUrl}/${key}`
 *   - signed:  `https://<acct>.r2.cloudflarestorage.com/[bucket/]${key}?X-Amz-…`
 *     written before backfill-public-image-urls.ts converted them.
 *
 * Returns null rather than a best guess. A wrong key makes the backfill copy
 * the wrong object into the private bucket and then, with --delete-source,
 * delete the right one — and an identity document has no second copy.
 */
export function deriveKey(
  url: string,
  publicBaseUrl: string,
  bucketName: string,
): string | null {
  const base = publicBaseUrl.replace(/\/+$/, '');

  // The `/` matters: without it `files.rabotka.cg.evil.com` starts with the
  // base as a string and would be accepted as ours.
  if (base && url.startsWith(base + '/')) {
    const key = decodeURI(url.slice(base.length + 1)).split('?')[0];
    return key || null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // Only a signed url may be read this way. Without this check any url on any
  // host would yield a plausible-looking key.
  if (!parsed.searchParams.has('X-Amz-Signature')) {
    return null;
  }

  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  if (segments.length === 0) return null;

  const keySegments = segments[0] === bucketName ? segments.slice(1) : segments;
  if (keySegments.length === 0) return null;

  return keySegments.join('/');
}
