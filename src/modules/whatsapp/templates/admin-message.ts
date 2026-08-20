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
 * Meta rejects newlines, tabs and runs of 4+ spaces INSIDE a template variable,
 * so an admin's multi-line message cannot be passed through as typed.
 *
 * The rule is not specific to this template — it binds every variable of every
 * template — so the implementation lives in `common/utils`, where the registry
 * and both provider mappers can reach it. Re-exported here because this is where
 * callers have always imported it from.
 */
export {
  flattenForTemplateVariable,
  sanitizeTemplateVariable,
} from '../../../common/utils/whatsapp-template-text.util';

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
 * (`rabotka_admin_message_v4`, authored in
 * `scripts/whatsapp-templates/definitions.ts`):
 *
 *   *Rabotka*
 *
 *   Message de notre équipe support concernant votre compte :
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
 *
 * v4 added the opening line, which says who is writing and about what. It did
 * NOT win back the UTILITY category — v3 and v4 were both reclassified to
 * MARKETING, and v2 holds UTILITY only because it carries the admin's name. The
 * line stays because it is honest about the sender and it widens the
 * variable-density margin; the marketing rate and opt-out exposure were
 * accepted knowingly. See the registry entry.
 */
export function formatAdminMessage(params: { message: string }): string {
  return [
    '*Rabotka*',
    '',
    'Message de notre équipe support concernant votre compte :',
    '',
    params.message,
    '',
    'Merci et à bientôt,',
    '_L’équipe Rabotka_',
  ].join('\n');
}
