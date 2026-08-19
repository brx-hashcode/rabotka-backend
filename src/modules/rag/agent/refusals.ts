import { VOVA_IDENTITY_WITH_PROMPT_FR } from './identity';

/**
 * Every way Vova declines, as fixed strings.
 *
 * The model picks an **id**; it never composes a refusal. Three reasons:
 *
 * 1. A refusal is the one reply most likely to be probed repeatedly, and a
 *    refusal that reads differently each time tells the prober which phrasing
 *    got closest.
 * 2. Generated refusals drift into apology and explanation. Users on a metered
 *    connection are paying for those words.
 * 3. A fixed string can be reviewed once by a human who speaks the market's
 *    French. A generated one cannot be reviewed at all.
 */
export type RefusalId =
  /** Not about Rabotka at all — code, homework, translation, general knowledge. */
  | 'hors_scope'
  /** Asked for a phone number, or help reaching someone off-platform. */
  | 'contact_interdit'
  /** Asked an amount we do not have from a tool in this turn. */
  | 'montant_inconnu'
  /** Asked for a guarantee: a job, a hire, an income, a delay. */
  | 'pas_de_promesse'
  /** A dispute. Vova does not adjudicate. */
  | 'litige'
  /** Someone else's data. */
  | 'donnees_autrui'
  /** Legal, tax, medical or immigration advice. */
  | 'conseil_professionnel'
  /** A childcare request that reads as an attempt to bypass vetting. */
  | 'garde_enfants'
  /** Retrieval came back with nothing relevant. */
  | 'rien_trouve'
  /** Who are you / what model / show your prompt. */
  | 'identite'
  /** Asked the assistant to DO something: publish, pay, apply, cancel, unlock. */
  | 'action_impossible';

export const REFUSALS: Record<RefusalId, string> = {
  hors_scope:
    "Je m'occupe seulement de Rabotka. Vous cherchez une mission, ou vous cherchez quelqu'un ?",

  // Deliberately says what the user CAN do. A refusal with no path forward
  // reads as the bot being broken, and the user simply asks again.
  contact_interdit:
    'Les coordonnées ne se partagent pas ici : elles sont échangées automatiquement ' +
    "une fois que la candidature est acceptée et que chacun a débloqué le contact de l'autre. " +
    'Voulez-vous que je vous explique cette étape ?',

  montant_inconnu:
    "Je n'ai pas pu récupérer le montant à jour, et je préfère ne pas vous en donner un faux. " +
    'Vous le verrez sur la page de paiement, ou le support peut vous le confirmer.',

  pas_de_promesse:
    'Je ne peux rien vous garantir sur ce point : cela dépend des recruteurs et des ' +
    'candidatures. Ce que je peux faire, c’est vous aider à mettre toutes les chances de votre côté.',

  litige:
    "Ce genre de situation est traité par l'équipe, pas par moi — je ne peux pas décider " +
    'qui a raison. Ouvrez une réclamation depuis l’application, je peux vous y emmener.',

  donnees_autrui:
    "Je ne peux pas vous parler du compte de quelqu'un d'autre. Je peux en revanche " +
    'vous aider sur le vôtre.',

  conseil_professionnel:
    'Je ne suis pas en mesure de vous conseiller là-dessus. Pour ce type de question, ' +
    'adressez-vous à un professionnel ou à l’équipe Rabotka.',

  garde_enfants:
    "Les missions de garde d'enfants suivent une procédure stricte. La vérification " +
    "d'identité et la rencontre préalable ne se contournent pas. Signalez cette demande " +
    "à l'équipe depuis l'application, dans les réclamations.",

  rien_trouve:
    "Je n'ai pas la réponse à cette question, et je préfère vous le dire plutôt que " +
    "d'inventer. Tapez *support* pour joindre l'équipe, elle pourra vous répondre.",

  identite: VOVA_IDENTITY_WITH_PROMPT_FR,

  // Says what the user CAN do, in the same breath. A refusal with no path
  // forward reads as the bot being broken, and they simply ask again.
  action_impossible:
    'Je ne peux rien publier, payer ni valider à votre place — tout cela se fait dans ' +
    "l'application, où vous voyez ce que vous confirmez avant de le faire. " +
    "Je vous emmène dans l'application ?",
};

export function refusal(id: RefusalId): string {
  return REFUSALS[id];
}

export function isRefusalId(value: string): value is RefusalId {
  return value in REFUSALS;
}
