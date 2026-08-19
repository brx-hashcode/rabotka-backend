import { foldText } from '../shared/text';

/**
 * When the app card is sent — and, mostly, when it is not.
 *
 * The card used to be appended to every reply. On a real conversation that
 * reads as a machine: you ask what Rabotka is, you get an answer and a card;
 * you ask why, you get an answer and the same card again. A card is an
 * interruption, and interrupting somebody who asked a question is what makes a
 * bot feel like a menu.
 *
 * So the card is sent when the person actually wants to go somewhere: they
 * asked to open the app, or they said yes to being offered it. Otherwise VoVa
 * answers, offers, and waits — the way a person would.
 */

/** « oui », « ok », « vas-y » — an answer to an offer, not a new question. */
const AFFIRMATIONS = [
  'oui',
  'oui stp',
  'oui svp',
  'oui merci',
  'ouais',
  'ok',
  'okay',
  'daccord',
  'd accord',
  'vas y',
  'allons y',
  'volontiers',
  'bien sur',
  'avec plaisir',
  'je veux bien',
  'oui je veux',
  'yes',
  'yep',
  'go',
];

/** An explicit request to go somewhere — no need to offer first. */
const NAVIGATION_REQUESTS = [
  // « Ouvre moi l'application » missed every pattern below and cost the user an
  // extra « Oui » for a request that could not have been more explicit.
  'ouvre moi',
  'ouvrez moi',
  'ouvre l application',
  'ouvre lapplication',
  'ouvrir l application',
  'ouvre l appli',
  'ouvre appli',
  'ouvre le tableau',
  'ouvre mes',
  'open the app',
  'open my',
  'ouvre le lien',
  'montre moi',
  'montre les',
  'emmene moi',
  'emmenez moi',
  'je veux voir',
  'je veux ouvrir',
  'donne moi le lien',
  'envoie le lien',
  'envoie moi le lien',
  'acceder a l application',
  'aller dans l application',
];

/**
 * True when the message is a bare yes.
 *
 * Deliberately strict: only a short message that IS an agreement counts. « oui
 * mais comment ça marche ? » is a question with a yes in front of it, and
 * answering it with a card would drop the question on the floor.
 */
export function isAffirmation(text: string): boolean {
  const folded = foldText(text);
  if (!folded || folded.length > 20) return false;
  return AFFIRMATIONS.includes(folded);
}

export function isNavigationRequest(text: string): boolean {
  const folded = foldText(text);
  if (!folded) return false;
  return NAVIGATION_REQUESTS.some((phrase) => folded.includes(phrase));
}

/**
 * Phrases with which VoVa proposes to OPEN something.
 *
 * Only after one of these does a « oui » mean "take me there". Without this
 * check the destination was remembered after every reply, so answering « oui »
 * to a question about content — « souhaitez-vous savoir à quoi sert ce crédit ? »
 * — sent the card instead of the explanation. The user asked a question, said
 * yes, and got a link.
 */
const NAVIGATION_OFFERS = [
  'je vous ouvre',
  'vous ouvrir',
  'peux vous ouvrir',
  't ouvrir',
  'je t ouvre',
  'je vous y emmene',
  'je t y emmene',
  'je vous emmene',
  'je t emmene',
  'vous y emmener',
  'ouvrir l application',
  'que je vous montre ou',
  'vous voulez que je vous ouvre',
  'i can open',
  'shall i open',
  'take you there',
];

/** True when the reply proposed to open a screen, rather than asking anything else. */
export function offersNavigation(reply: string): boolean {
  const folded = foldText(reply);
  return NAVIGATION_OFFERS.some((phrase) => folded.includes(phrase));
}
