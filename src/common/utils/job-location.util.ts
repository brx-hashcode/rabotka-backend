/** What a remote job shows where an address would otherwise go. */
export const REMOTE_LOCATION_LABEL = 'En ligne';

/**
 * A job offer's location as one line of human-readable text.
 *
 * `address` is null for a remote job, and every surface that renders one — the
 * WhatsApp messages, the contract PDF, the CV, the admin list — needs a string.
 * Centralising it here means a remote job reads "En ligne" everywhere instead
 * of each caller inventing its own placeholder, or worse, printing an empty
 * line where the address used to be.
 */
export function jobLocationLabel(offer: { address?: string | null }): string {
  const address = offer.address?.trim();
  return address || REMOTE_LOCATION_LABEL;
}
