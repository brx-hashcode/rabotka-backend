/**
 * Reconstructing an R2 object key from a url, and recognising a KYC key.
 *
 * Lives in `src/` rather than `prisma/` because both the runtime and the
 * backfill script need it. It was script-only before, which is exactly why
 * `POST /profile` never derived a key of its own and instead trusted whatever
 * the client sent — a client that sent nothing produced a row that could never
 * be signed, and the document became unviewable the hour after it was uploaded.
 *
 * Pure functions, no Nest imports, so `prisma/*.ts` can import it under `tsx`.
 *
 * Three url shapes exist in the data:
 *   - public:          `${publicBaseUrl}/${key}`
 *   - path-style:      `https://<acct>.r2.cloudflarestorage.com/<bucket>/${key}?X-Amz-…`
 *   - virtual-hosted:  `https://<bucket>.<acct>.r2.cloudflarestorage.com/${key}?X-Amz-…`
 *
 * The last two are the same request signed by different SDK settings, and they
 * put the bucket in different places. Reading only one shape is how the earlier
 * version got a key wrong: it stripped the leading path segment whenever that
 * segment matched the ONE bucket name it was given (always the public one), so
 * a path-style url naming the KYC bucket yielded
 * `rabotka-kyc-document/kyc-documents/x.jpg`. Today's urls happen to be
 * virtual-hosted, so it was right by luck — one `forcePathStyle` flip from
 * copying the wrong object and then deleting the right one.
 *
 * Returns null rather than a best guess. A wrong key makes the backfill copy
 * the wrong object into the private bucket and then, with --delete-source,
 * delete the only copy of somebody's passport.
 */

/** Folders the KYC uploads write to. `uploadKycFile` uses the first, and
 *  `verifyProfileKyc` the second. */
export const KYC_KEY_PREFIXES = ['kyc-documents/', 'kyc-verification/'];

export type DerivedKey = {
  key: string;
  /**
   * The bucket the url named, when it named one. Null for a public-base url:
   * that host fronts a bucket but does not identify it, so claiming a name
   * here would be a guess. A caller that needs to know "public or private"
   * reads null as "the bucket behind the public base".
   */
  bucket: string | null;
};

export function deriveKey(
  url: string,
  publicBaseUrl: string,
  buckets: string[],
): DerivedKey | null {
  const base = publicBaseUrl.replace(/\/+$/, '');

  // The `/` matters: without it `files.rabotka.cg.evil.com` starts with the
  // base as a string and would be accepted as ours.
  if (base && url.startsWith(base + '/')) {
    const key = decodeURI(url.slice(base.length + 1)).split('?')[0];
    return key ? { key, bucket: null } : null;
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

  const known = buckets.map((b) => b.trim()).filter(Boolean);

  let segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => decodeURIComponent(s));
  if (segments.length === 0) return null;

  // Virtual-hosted style: the bucket is the first label of the hostname, and
  // the ENTIRE path is the key. Stripping a segment here would eat the first
  // folder of the key.
  const firstLabel = parsed.hostname.toLowerCase().split('.')[0];
  let bucket: string | null = null;

  if (known.includes(firstLabel)) {
    bucket = firstLabel;
  } else if (known.includes(segments[0])) {
    // Path-style: the bucket leads the path.
    bucket = segments[0];
    segments = segments.slice(1);
  }
  // Otherwise the url names no bucket we know. The whole path is the key —
  // which is right for a path-style url against a bucket that was renamed, and
  // harmless for anything else, since the caller still has to find the object.

  if (segments.length === 0) return null;

  return { key: segments.join('/'), bucket };
}

/**
 * The canonical, non-fetchable reference stored in `document_url` /
 * `image_url`.
 *
 * Those columns used to hold whatever url the upload returned — for KYC that is
 * a signed url that dies within the hour, so the column held an expired
 * credential permanently. `storage_key` is the source of truth now, and this is
 * what goes beside it: it names the bucket, it survives, and no code path can
 * mistake it for something to fetch.
 *
 * `s3://` rather than a bare key on purpose. A bare `kyc-documents/x.jpg`
 * passes an is-this-an-image check and, dropped into an `<img src>`, resolves
 * against the admin's own origin — a silent 404 that looks exactly like the bug
 * this replaces.
 */
export function kycObjectRef(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

/**
 * What a stored url is still worth serving directly, for a row with no key.
 *
 * Only a legacy PUBLIC url qualifies. Two other things live in that column and
 * neither may reach a browser: an `s3://` ref, which is not fetchable and
 * renders as a silent 404 relative to whatever origin loads it; and an old
 * signed url, which is a dead credential and 403s. Both used to be handed
 * straight to the admin's `<img>` — the second is the bug being fixed.
 *
 * Null means "tell the caller there is no file", which the UI can say plainly,
 * instead of a link that fails in the browser for reasons nobody can see.
 */
export function legacyKycUrl(storedUrl: string | null): string | null {
  if (!storedUrl) return null;
  if (!/^https?:\/\//i.test(storedUrl)) return null;
  if (storedUrl.includes('X-Amz-Signature')) return null;
  return storedUrl;
}

/**
 * Whether a key addresses a KYC object at all.
 *
 * Guards the client-supplied `kycDocumentKey` hint. Without it, `POST /profile`
 * would accept any key the caller cared to name and hand back a signed url for
 * it — an arbitrary-object read against the private bucket.
 */
export function isKycKey(key: string): boolean {
  if (!key || key.startsWith('/')) return false;

  // `..` would climb out of the folder; an empty segment means a `//` that S3
  // and R2 disagree about normalising.
  const segments = key.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;

  return KYC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}
