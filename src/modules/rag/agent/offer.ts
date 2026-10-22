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

/**
 * A bare hello — nothing else in the message.
 *
 * Its own list rather than the router's `GREETINGS`, deliberately. That one
 * answers "could a smaller model handle this?", which is a cost question and
 * can afford to be generous; this one answers "should we reply with a fixed
 * hello and no model call at all?", which is a correctness question and cannot.
 * They will diverge — the router's list already contains « ok » and « d'accord »,
 * which are agreements handled by {@link isAffirmation} above and would be
 * absurd to answer with « Bonjour ». Sharing one list would make each change to
 * either decision silently change the other.
 */
const PURE_GREETINGS = [
  'bonjour',
  'bonsoir',
  'bjr',
  'bsr',
  'salut',
  'coucou',
  'hello',
  'hi',
  'hey',
  'mbote',
  'bonjour vova',
  'salut vova',
  'hello vova',
  'bonjour a tous',
  'good morning',
  'good evening',
];

/**
 * True only when the whole message is a greeting.
 *
 * EXACT match after folding, not `startsWith` — « bonjour, combien coûte un
 * déblocage ? » is a question with a hello in front of it, and answering it
 * with a fixed greeting would drop the question on the floor. That is the same
 * trap {@link isAffirmation} documents, and the same answer.
 */
export function isPureGreeting(text: string): boolean {
  const folded = foldText(text);
  if (!folded || folded.length > 20) return false;
  return PURE_GREETINGS.includes(folded);
}

/**
 * A message that CLOSES the exchange rather than opening one.
 *
 * "merci", "non merci", "je vois", "ok", "non laisse" — the person is done.
 * They are not asking anything, and they are not greeting.
 *
 * Its own list, for the same reason {@link PURE_GREETINGS} is its own: the
 * router's lists answer "could a cheaper model take this?", a cost question.
 * This one answers "should anything be sent back beyond an acknowledgement?",
 * which is a correctness question — and getting it wrong is what produced a
 * real transcript where every « non merci » was answered with a full
 * reintroduction and a card, until the person wrote « arrête avec vos messages
 * bête la ».
 *
 * NOTE « non merci » AND « merci » both belong here. A refusal is still a
 * close: answering it with "how can I help you today?" is not listening.
 */
const ACKNOWLEDGEMENTS = [
  'merci',
  'merci bien',
  'merci beaucoup',
  'mercii',
  'non merci',
  'ok merci',
  'merci ok',
  'je vois',
  'd accord',
  'daccord',
  'ok',
  'okay',
  'oki',
  'non laisse',
  'laisse',
  'laisse tomber',
  'c est bon',
  'cest bon',
  'ca va',
  'rien',
  'non rien',
  'thanks',
  'thank you',
  'thx',
  'no thanks',
  'nothing',
  'matondi',
];

/**
 * The pieces a close is built from.
 *
 * People stack them, and across two lines: « D'accord \n Merci », « Ok \n
 * Merci ». Enumerating every pair in {@link ACKNOWLEDGEMENTS} would be a
 * combinatorial list that still misses the next one somebody types, so the
 * whole message is consumed atom by atom instead.
 *
 * Longest first — « d accord » must be tried before « d », and « laisse
 * tomber » before « laisse ».
 */
const CLOSING_ATOMS = [
  'laisse tomber',
  'thank you',
  'merci beaucoup',
  'd accord',
  'c est bon',
  'je vois',
  'no thanks',
  'daccord',
  'cest bon',
  'beaucoup',
  'matondi',
  'nothing',
  'thanks',
  'laisse',
  'mercii',
  'merci',
  'bien',
  'rien',
  'okay',
  'non',
  'thx',
  'oki',
  'ok',
].sort((a, b) => b.length - a.length);

/**
 * True only when the WHOLE message is an acknowledgement.
 *
 * Nothing is matched loosely: « merci, et comment je postule ? » is a question
 * with a thank-you in front of it, and answering that with "de rien" drops the
 * question on the floor. That is the trap {@link isPureGreeting} documents, and
 * the same answer — the message must be a close ENTIRELY.
 *
 * Two ways to qualify. Either the folded text is one of the phrases above, or
 * it decomposes into TWO OR MORE closing atoms and nothing else.
 *
 * The two-atom floor is what keeps a bare « non » out. Alone it is an answer —
 * to "voulez-vous que je regarde ?" it means no, and it deserves a real reply.
 * Stacked, as in « non merci », it is a close. Same word, different message.
 */
export function isAcknowledgement(text: string): boolean {
  const folded = foldText(text);
  if (!folded || folded.length > 30) return false;
  if (ACKNOWLEDGEMENTS.includes(folded)) return true;

  let rest = folded;
  let atoms = 0;

  while (rest.length > 0) {
    const atom = CLOSING_ATOMS.find(
      (candidate) => rest === candidate || rest.startsWith(`${candidate} `),
    );
    if (!atom) return false;
    rest = rest.slice(atom.length).trimStart();
    atoms += 1;
  }

  return atoms >= 2;
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

/**
 * A stranger saying they want in — the moment the signup card is worth showing
 * again. Substring on the folded text, like the navigation phrases above.
 */
const JOIN_INTENT = [
  'inscri',
  'creer un compte',
  'creer mon compte',
  'ouvrir un compte',
  'avoir un compte',
  'enregistrer',
  'rejoindre',
  'comment commencer',
  'je veux commencer',
  'sign up',
  'register',
  'create an account',
];

export function wantsToJoin(text: string): boolean {
  const folded = foldText(text);
  return JOIN_INTENT.some((phrase) => folded.includes(phrase));
}

/**
 * The reply itself said the number has no account yet — the prompt asks for
 * that on the first answer and whenever an account becomes the point, so the
 * card follows the model's own judgement rather than a second, separate one.
 */
const MISSING_ACCOUNT = [
  'pas encore de compte',
  'pas de compte',
  'no account',
  'don t have an account',
  'do not have an account',
];

export function mentionsMissingAccount(reply: string): boolean {
  const folded = foldText(reply);
  return MISSING_ACCOUNT.some((phrase) => folded.includes(phrase));
}
