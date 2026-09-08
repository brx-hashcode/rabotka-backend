/**
 * The one image allowlist, and the pieces that read it.
 *
 * The same three mime types were copy-pasted into five controllers
 * (`portfolio`, two in `profile`, two in `admin-profile`) with three different
 * rejection behaviours between them. Nothing forced them to agree, so tightening
 * one of them left the others open.
 *
 * Pure functions, no Nest imports, so `prisma/*.ts` can import it under `tsx` —
 * the same reason `kyc-key.ts` is shaped this way.
 */

/** What a browser may send. Checked against the client-supplied `mimetype`, so
 *  this is a first line, never the only one — see `EXTENSION_FOR_MIME`. */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/**
 * The extension a stored key is allowed to end in.
 *
 * NOT the same list as `kycContentKind`'s `IMAGE_EXTENSIONS`, and deliberately
 * so: no `gif`, no `heic`/`heif` (sharp transcodes those to JPEG while the
 * generated key keeps the original extension, so the key would lie), and above
 * all no `svg`.
 *
 * `svg` is excluded because these objects are served from the public bucket
 * under a permanent unauthenticated url. An SVG is a document: it may carry
 * `<script>`, and a browser that navigates to one executes it on the CDN's
 * origin. `rabotka-admin`'s `is-likely-image-asset.ts` does count `svg` as an
 * image — that is a rendering hint for files we already trust, not an upload
 * gate. Do not "fix" the inconsistency by adding it here.
 */
export const ALLOWED_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

/** Per-file ceiling, matching what portfolio and avatar uploads already use. */
export const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The extension to store an accepted image under.
 *
 * `FileService.uploadToStorage` builds its key from `file.originalname`, which
 * is client-supplied and never sanitised. A file called `payload.svg` sent with
 * `Content-Type: image/jpeg` passes a mimetype filter and lands under a `.svg`
 * key — the exact thing `ALLOWED_IMAGE_EXTENSIONS` exists to prevent. Deriving
 * the extension from the mime type instead closes that gap at the source, so
 * the key can never disagree with the type we validated.
 */
export const EXTENSION_FOR_MIME: Record<AllowedImageMimeType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function isAllowedImageMimeType(
  mimeType: string,
): mimeType is AllowedImageMimeType {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Whether an object key names one of the image types we accept.
 *
 * Reads the LAST dot segment, and treats a key with no dot as failing —
 * `'photo'.split('.').pop()` is `'photo'`, which would otherwise sail through
 * as an unrecognised extension rather than being rejected.
 */
export function hasAllowedImageExtension(key: string): boolean {
  const dot = key.lastIndexOf('.');
  if (dot <= 0 || dot === key.length - 1) return false;

  const ext = key.slice(dot + 1).toLowerCase();
  return ALLOWED_IMAGE_EXTENSIONS.includes(ext);
}
