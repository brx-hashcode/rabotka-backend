import { ctaReply } from '../../../common/constants/whatsapp-carousel';
import {
  CLAIM_FORM_CTA_PATH,
  OPEN_APP_CTA_PATH,
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
  const lines = ['*Support Rabotka*', ''];

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

  const body = lines.join('\n');
  const link = whatsappSupportLink(contact.phone, opts);
  if (!link) return body;

  // One link button is all a free-form CTA carries, so the button opens the
  // support chat and the email stays in the text. The fallback is the same
  // card without the button: there is no approved template for it.
  return ctaReply({
    body,
    buttonText: 'Écrire au support',
    url: link,
    fallbackText: body,
  });
}

/**
 * A wa.me link to the support number, with a first message already typed so
 * support knows why the person is writing. Null without a usable number.
 */
export function whatsappSupportLink(
  phone: string,
  opts?: { suspended?: boolean },
): string | null {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  const text = opts?.suspended
    ? 'Bonjour, mon compte Rabotka est suspendu.'
    : 'Bonjour, j’ai besoin d’aide sur Rabotka.';
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/**
 * @deprecated Use {@link supportCardBotMessage}, which carries the suspension
 * reason. Kept only until the last caller moves.
 */
export function accountSuspendedBotMessage(contact: ContactInfo): string {
  return supportCardBotMessage(contact);
}

/**
 * The card the bot closes a reply with: one line and a button.
 *
 * BUILT BY THE BOT, not sent as its approved template. It used to be
 * `templateReply('openApp', …)`, on the reasoning written right where it was
 * called — "a bare link does not open WhatsApp's in-app browser, only a
 * template's CTA button does". True of a bare link, and not true of the message
 * since `ctaReply` existed: a free-form `cta_url` carries the same button, and
 * this is a REPLY, so it is inside the 24h window where free-form is allowed
 * and costs nothing.
 *
 * SHORT, AND IT DOES NOT COPY THE TEMPLATE. The first version of this repeated
 * the approved wording — "Suite à votre message, voici l'accès à votre espace
 * … L'équipe Rabotka" — on the reasoning that the card and its fallback should
 * not say different things. That was the wrong instinct. A template is
 * business-initiated: it arrives cold, hours later, and has to reintroduce
 * itself and sign off. This card is the last line of a conversation already in
 * progress, and a signature in the middle of a chat reads like a letter
 * somebody pasted in.
 *
 * So the two say the same THING in the register each belongs to, and the
 * template keeps its letter form for the case it is actually for — a window
 * that shut between the reply being built and the job draining.
 *
 * `openApp` is UTILITY rather than MARKETING, so that fallback is the cheap
 * kind rather than the expensive one — but free beats cheap on every reply.
 */
/**
 * What a REFUSED dossier gets when the assistant has nothing to say.
 *
 * The generic door (`openAppBotMessage`) is deliberately mute about why an
 * account is walled — one card serves all three walled states, and the
 * assistant is supposed to supply the reason. That holds right up until the
 * assistant returns null, which it does whenever VoVa is disabled, out of
 * budget, timed out or thrown. Then the mute card is the ONLY thing sent.
 *
 * From a real transcript: a worker whose KYC had just been refused wrote « Ma
 * CNI a été volé, il ne me reste plus que la copie maintenant comment dois-je
 * faire ? » and received "Compte, missions et messages : tout est dans
 * l'application." A stolen identity document is the moment this product is
 * most obliged to answer, and it answered with a door.
 *
 * So the refused state gets its own fallback, and it says the one thing the
 * system prompt already tells the assistant to say (`prompts.ts`, the REJECTED
 * branch): documents cannot be re-sent from the app, and the route forward is
 * a réclamation. Deterministic on purpose — it has to work on the day the
 * model does not.
 *
 * The button lands on the claim FORM rather than `/home`: somebody who has
 * just been told to file a réclamation should not then have to find it.
 */
export function kycRejectedHelpMessage(firstName: string): string {
  return ctaReply({
    body: [
      '*Votre vérification a été refusée*',
      '',
      'Vos documents ne peuvent pas être renvoyés depuis l’application.',
      'Pour faire examiner votre situation — pièce perdue, volée, ou refus que vous contestez — ouvrez une réclamation : l’équipe vous répondra dans la conversation.',
    ].join('\n'),
    buttonText: 'Ouvrir une réclamation',
    path: CLAIM_FORM_CTA_PATH,
    // The window may have shut between the reply being built and the job
    // draining. `openApp` is the approved UTILITY letter we already own; it
    // lands on /home rather than the form, which is the honest limit of a
    // template written for something else.
    fallbackTemplate: 'openApp',
    fallbackVariables: WHATSAPP_TEMPLATES.openApp.variables(firstName),
  });
}

export function openAppBotMessage(firstName: string): string {
  return ctaReply({
    body: [
      '*Votre espace Rabotka*',
      'Compte, missions et messages : tout est dans l’application.',
    ].join('\n'),
    buttonText: 'Voir mon compte',
    // A path: the outbound worker mints the one-tap `/s/<code>` link, exactly
    // as it does for the template's button.
    path: OPEN_APP_CTA_PATH,
    // The letter-form template, for a window that shut in between. It still
    // takes the name — it is the one that has to reintroduce itself.
    fallbackTemplate: 'openApp',
    fallbackVariables: WHATSAPP_TEMPLATES.openApp.variables(firstName),
  });
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
