import { ctaReply } from '../../../common/constants/whatsapp-carousel';
import {
  PENALTIES_PAYMENT_CTA_PATH,
  WHATSAPP_TEMPLATES,
} from '../../../common/constants/whatsapp-templates';


export type ContactInfo = {
  email: string;
  phone: string;
  address: string;
};

/**
 * The support card.
 *
 * Answers `/support` for any account, and stands in as the whole reply for a
 * suspended one. `reason` is the admin's own words when the suspension has
 * them — "your account is suspended" with no motive leaves the reader with
 * nothing to act on, which is the entire point of storing it.
 */
export function supportCardBotMessage(
  contact: ContactInfo,
  opts?: { suspended?: boolean; reason?: string | null },
): string {
  const lines = ['Support Rabotka', ''];

  // Driven by the STATUS, not by whether a reason happens to be stored. Keying
  // it off the reason meant every suspension predating the suspension_reason
  // column produced a card that never mentioned the suspension at all.
  if (opts?.suspended) {
    lines.push('Votre compte est suspendu.', '');
    if (opts.reason?.trim()) {
      lines.push(`Motif : ${opts.reason.trim()}`, '');
    }
  }

  lines.push(
    'Notre équipe vous répond du lundi au samedi, de 8h à 18h :',
    '',
    `*Email* : ${contact.email}`,
    `*Téléphone* : ${contact.phone}`,
  );

  return lines.join('\n');
}

/**
 * @deprecated Use {@link supportCardBotMessage}, which carries the suspension
 * reason. Kept only until the last caller moves.
 */
export function accountSuspendedBotMessage(contact: ContactInfo): string {
  return supportCardBotMessage(contact);
}

/**
 * What a person with unpaid penalties gets instead of the feature they asked
 * for: a button into the app, where penalties are paid.
 *
 * Payment used to happen in the chat — « tapez 1 », pick a number, choose a
 * method. It lives in the app now, so the chat only says what is blocked and
 * opens the page. Sent as a reply, so the free-form card is inside the 24h
 * window; the fallback only covers a window that closed in between.
 */
export function hasPenaltiesBotMessage(firstName: string): string {
  return ctaReply({
    body: [
      '⚠️ *Pénalités impayées*',
      '',
      'Tant qu’elles ne sont pas réglées, vous ne pouvez pas postuler, publier d’offre ni débloquer de contact.',
      '',
      'Réglez-les en quelques instants dans l’application.',
    ].join('\n'),
    buttonText: 'Payer mes pénalités',
    path: PENALTIES_PAYMENT_CTA_PATH,
    fallbackTemplate: 'openApp',
    fallbackVariables: WHATSAPP_TEMPLATES.openApp.variables(firstName),
  });
}

/**
 * Re-prompt inside a flow.
 *
 * Now names the escape. This is what someone stuck mid-flow sees, and it
 * previously pointed nowhere — the reader had to already know that "menu" got
 * them out. `/` is the discoverable version of that, and it works from inside
 * any flow (see `expandSlashCommand`).
 */
export function unknownCommandMessage(): string {
  return [
    "Je n'ai pas compris votre réponse. Merci de réessayer.",
    '',
    'Envoyez */* à tout moment pour revenir aux options.',
  ].join('\n');
}
