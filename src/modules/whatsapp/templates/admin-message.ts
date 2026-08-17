/**
 * Admin-authored messages sent from the back office.
 *
 * These go out one of two ways depending on WhatsApp's 24h customer-service
 * window (see `WhatsAppService.isServiceWindowOpen`): free-form text while the
 * window is open, and the approved `rabotka_admin_message` template once it has
 * closed. Both render the SAME body — `formatAdminMessage` below is the single
 * source of that shape, and it must stay byte-identical to the approved Twilio
 * body (`TEMPLATES.admin_message` in the repo-root `script.js`). If the two
 * drift, the admin thread silently misrepresents what the profile received.
 */

/**
 * Meta rejects newlines, tabs and runs of 4+ spaces INSIDE a ContentVariables
 * value, so an admin's multi-line message cannot be passed through as typed.
 *
 * Pass order is load-bearing: collapsing spaces and tabs BEFORE the newline
 * passes stops `"a  \n  b"` from leaving a doubled space behind, and the final
 * pass mops up whatever inserting the separator created.
 *
 * Paragraph breaks become a visible `·` rather than a plain space — flattening
 * a three-paragraph message with spaces alone produces an unreadable run-on.
 */
export function flattenForTemplateVariable(text: string): string {
  const flattened = text
    // Up front, so leading/trailing blank lines never become an edge separator.
    .trim()
    .replace(/\r\n?/g, '\n')
    // Control and format characters (zero-width joiners, bidi marks) survive
    // a copy-paste out of a browser and are rejected inside a variable. \n and
    // \t are control characters too, so they are spared here and normalised by
    // the passes below. Written as Unicode property escapes so this file needs
    // no literal control bytes of its own.
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === '\n' || c === '\t' ? c : ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, ' · ')
    .replace(/\n/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();

  // A message that was only blank lines flattens to nothing but separators,
  // which would sail past the caller's emptiness check and send a bare "·".
  // Tested rather than stripped: one anchored character class, no backtracking.
  return /^[·\s]*$/.test(flattened) ? '' : flattened;
}

/**
 * Ceiling on the flattened message.
 *
 * Meta's rendered BODY cap is 1024 characters. The template's static text plus
 * the admin's name accounts for a small part of that; 700 leaves headroom for a
 * long name and for counting discrepancies on accented text. Deliberately
 * conservative — raise it once a real send establishes the actual threshold.
 */
export const ADMIN_MESSAGE_VAR_MAX = 700;

/**
 * The body a profile actually receives, in BOTH delivery modes.
 *
 * Keep byte-identical to the approved template body
 * (`rabotka_admin_message_v3`, authored in
 * `scripts/whatsapp-templates/definitions.ts`):
 *
 *   *Rabotka*
 *
 *   {{1}}
 *
 *   Merci et à bientôt,
 *   _L’équipe Rabotka_
 *
 * Neither static line is decoration. A template body may not start or end with a
 * variable (Meta subCode 2388299), and the v1 body — which had only these two
 * short static fragments around the variables — was rejected outright with
 * subCode 2388293, "too many variables for its length". The closing line is what
 * buys that ratio back. Both lines are emitted on the free-form path too, so the
 * two delivery modes render identically.
 *
 * v3 dropped the sender's name. v2 signed each message with the individual
 * admin's name via a second variable; Rabotka answers as one team, and since a
 * variable may never be empty there was no value that rendered as the team
 * alone.
 */
export function formatAdminMessage(params: { message: string }): string {
  return [
    '*Rabotka*',
    '',
    params.message,
    '',
    'Merci et à bientôt,',
    '_L’équipe Rabotka_',
  ].join('\n');
}
