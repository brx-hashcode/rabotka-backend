/**
 * Which hosts `GET /file/proxy` may fetch from.
 *
 * The proxy exists for one thing: letting the admin read OUR stored files
 * without tripping over the storage host's missing CORS headers. So the only
 * hosts it needs are the ones storage can hand out urls for — and those are
 * derived here from the storage settings rather than typed into an env var
 * somebody has to remember.
 *
 * It used to fetch ANY url that did not match a short regex of private
 * addresses, unless `PROXY_ALLOWED_HOSTS` happened to be set. A hostname that
 * resolves to an internal address, an IPv6 literal, a compose service name
 * (`redis`, `qdrant`) or a redirect all walked straight past that regex, and
 * the body came back to the caller.
 *
 * Every driver is considered, not only the active one: a file stored before a
 * switch of driver still has a url on the old host.
 */
export type StorageSetting = (key: string) => string;

export function storageProxyHosts(
  setting: StorageSetting,
  extraHosts = '',
): string[] {
  const hosts = new Set<string>();
  const add = (host: string | null) => {
    if (host) hosts.add(host.toLowerCase());
  };

  // Cloudflare R2: the public bucket's base url, and the account endpoint that
  // signed urls are issued on (path-style and `<bucket>.`-prefixed alike).
  add(hostOf(setting('CLOUDFLARE_PUBLIC_BASE_URL')));
  const account = setting('CLOUDFLARE_ACCOUNT_ID');
  if (account) add(`${account}.r2.cloudflarestorage.com`);

  // S3, or anything S3-compatible behind a custom endpoint.
  add(hostOf(setting('AWS_ENDPOINT_URL')));
  const bucket = setting('AWS_S3_BUCKET');
  if (bucket) {
    add(`${bucket}.s3.amazonaws.com`);
    const region = setting('AWS_REGION');
    if (region) add(`${bucket}.s3.${region}.amazonaws.com`);
  }

  if (setting('CLOUDINARY_CLOUD_NAME')) add('res.cloudinary.com');
  if (setting('BLOB_READ_WRITE_TOKEN')) add('public.blob.vercel-storage.com');

  for (const extra of extraHosts.split(',')) add(extra.trim() || null);

  return [...hosts];
}

/** Exact host, or a subdomain of one — never a suffix that merely ends alike. */
export function isProxyHostAllowed(
  hostname: string,
  allowed: readonly string[],
): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((h) => host === h || host.endsWith(`.${h}`));
}

function hostOf(url: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
