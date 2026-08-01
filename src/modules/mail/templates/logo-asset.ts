/**
 * The brand logo, embedded in the message rather than linked.
 *
 * Mail clients block external images by default — most recipients never press
 * "Show images", so a linked logo is simply never seen. An inline attachment is
 * part of the message, so clients render it without that prompt.
 *
 * Base64 rather than a file on disk: it compiles into the bundle, so it cannot
 * go missing from a build or a container image. A missing asset would break the
 * logo in every email with no fallback, since a cid: src has nowhere else to
 * point.
 *
 * 112x112 (2x the 56px display size, for retina) and ~5 KB, down from the
 * 1934x1934 / 339 KB original — small enough to ride along on every email.
 */
const RABOTKA_LOGO_BASE64 =
  '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';

/** Referenced from the layout as `src="cid:{RABOTKA_LOGO_CID}"`. */
export const RABOTKA_LOGO_CID = 'rabotka-logo';

export const RABOTKA_LOGO_FILENAME = 'rabotka-logo.png';

export function rabotkaLogoBuffer(): Buffer {
  return Buffer.from(RABOTKA_LOGO_BASE64, 'base64');
}
