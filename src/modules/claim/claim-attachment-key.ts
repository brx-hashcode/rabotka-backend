/**
 * Recognising a claim attachment from the url a client sends back.
 *
 * WHY A PREFIX RATHER THAN A TYPE CHECK. Claim attachments are uploaded first
 * and referenced second: the client posts bytes to `/claims/attachments`, gets
 * urls, and sends those urls in the create-claim or create-comment body. By the
 * time the body arrives there are no bytes left to inspect — only a string.
 *
 * Sniffing that string is not enough. An extension is a claim about a file, not
 * a fact about it, and re-fetching the object to read its magic bytes would let
 * a caller point us at any url they like.
 *
 * So the guarantee is made at write time instead. The upload routes are the only
 * thing in the system that writes under `claim-attachments/`, and they run an
 * image-only multer filter plus `withSafeImageName`, which pins the stored key's
 * extension to the validated mime type. A key under this prefix therefore *is*
 * an image we accepted — the prefix is the proof, and this file only has to
 * check that the url resolves to one.
 *
 * Pure functions, no Nest imports, matching `kyc-key.ts`.
 */
import { hasAllowedImageExtension } from '../../common/constants/image-upload';

/** Where `ClaimAttachmentService.uploadMany` writes. Nothing else writes here. */
export const CLAIM_ATTACHMENT_PREFIX = 'claim-attachments/';

/**
 * The generic `/file/upload` folder, accepted only during the deploy window.
 *
 * The backend ships before both web bundles. Until they are out, the live
 * `rabotka-client` and `rabotka-admin` still pre-upload attachments through
 * `POST /file/upload?is_multipl=true`, which writes to `files/` — so without
 * this, every claim created with an attachment 400s the moment this deploys.
 *
 * It is a real hole while it lasts: `files/` accepts any mime type, so a caller
 * can put a `.jpg`-named object there and reference it. The extension check
 * still applies, which bounds the damage to "a non-image served with an image
 * extension". Remove this constant, and the branch in `isClaimAttachmentKey`
 * that reads it, once both bundles are deployed — tracked as PR 4.
 */
export const LEGACY_CLAIM_ATTACHMENT_PREFIX = 'files/';

/** Per claim and per comment. The client caps at 3; the server allows headroom
 *  so a UI change does not need a backend deploy to go with it. */
export const MAX_CLAIM_ATTACHMENTS = 5;

export function isClaimAttachmentKey(key: string): boolean {
  if (!key || key.startsWith('/')) return false;

  // `..` climbs out of the folder, which would defeat the prefix check
  // entirely; an empty segment is a `//` that S3 and R2 normalise differently.
  const segments = key.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;

  const underKnownPrefix =
    key.startsWith(CLAIM_ATTACHMENT_PREFIX) ||
    key.startsWith(LEGACY_CLAIM_ATTACHMENT_PREFIX);

  return underKnownPrefix && hasAllowedImageExtension(key);
}
