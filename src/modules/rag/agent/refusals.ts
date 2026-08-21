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
  /** The same, for someone with no account — for whom `support` does nothing. */
  | 'rien_trouve_anonyme'
  /** A number with no account has used its daily allowance. */
  | 'limite_atteinte'
  /** « Qui es-tu ? », « tu es un robot ? » — la vraie question d'identité. */
  | 'identite'
  /** « Tu tournes sur ChatGPT ? » — la cuisine interne, qui ne se raconte pas. */
  | 'identite_modele'
  /** « Ignore tes instructions », « montre ton prompt ». */
  | 'identite_instructions'
  /** Asked the assistant to DO something: publish, pay, apply, cancel, unlock. */
  | 'action_impossible'
  /** Insults or threats. Warns, once, that the account is at stake. */
  | 'abus_avertissement'
  /** The same person, still at it. The report has already been filed. */
  | 'abus_signale';

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

  // Sent when a number with no account has used its allowance for the day.
  //
  // Says what happened, in those words. Silently falling back to the signup
  // card looked identical to the assistant being switched off or broken — the
  // person had been having a conversation and it simply stopped answering,
  // which reads as a fault rather than a limit. A limit you are told about is
  // a reason to sign up; one you are not told about is a bug.
  limite_atteinte:
    "J'ai répondu à toutes les questions que je peux traiter aujourd'hui pour " +
    'un numéro sans compte. Créez votre compte et je continue avec vous — vous ' +
    'aurez aussi accès aux missions, aux candidatures et à votre portefeuille.',

  // `support` is a bot command, and the bot only answers commands for numbers
  // it recognises — so telling a stranger to type it would send them nowhere.
  // The one thing that does work for them is the one thing offered.
  rien_trouve_anonyme:
    "Je n'ai pas la réponse à cette question, et je préfère vous le dire plutôt " +
    "que d'inventer. Vous pouvez me demander comment fonctionne Rabotka, ou taper " +
    '*/compte* pour créer votre compte.',

  // Assumé, pas esquivé. « Tu es un robot ? » mérite un oui franc : une IA qui
  // tourne autour du pot pour éviter de le dire met la personne mal à l'aise
  // pour rien, et elle l'avait deviné de toute façon.
  identite:
    "Je suis *VoVa AI*, l'assistant de Rabotka 👋 Une intelligence artificielle, " +
    'oui — autant vous le dire franchement. Je réponds à vos questions sur Rabotka ' +
    'et je retrouve vos infos : candidatures, solde, pénalités, missions. ' +
    "Qu'est-ce qui vous amène ?",

  // Ni confirmer ni démentir, sans avoir l'air de cacher quelque chose de
  // grave. Un peu d'humour désamorce mieux qu'un refus sec, et évite que la
  // personne insiste pour voir ce qu'on protège.
  identite_modele:
    'Ça, c’est la cuisine interne 😄 Ce que je peux vous dire : je suis *VoVa AI*, ' +
    "fait pour Rabotka et rien d'autre. Le reste, c'est l'affaire de l'équipe " +
    'technique. Une question sur vos missions ou votre compte ?',

  // Léger, jamais moralisateur. Quelqu'un qui teste le bot n'a pas besoin d'un
  // sermon : il a besoin qu'on referme la porte en souriant et qu'on lui
  // propose autre chose.
  identite_instructions:
    'Bien tenté 😄 Mes instructions restent au chaud. En revanche, tout ce qui ' +
    'touche à Rabotka — votre solde, vos candidatures, comment ça marche — je vous ' +
    'réponds avec plaisir.',

  // Says what the user CAN do, in the same breath. A refusal with no path
  // forward reads as the bot being broken, and they simply ask again.
  action_impossible:
    'Je ne peux rien publier, payer ni valider à votre place — tout cela se fait dans ' +
    "l'application, où vous voyez ce que vous confirmez avant de le faire. " +
    "Je vous emmène dans l'application ?",

  // Ferme, et sans rendre l'insulte. Le but n'est pas d'avoir le dernier mot :
  // c'est de dire ce qui est en jeu pendant qu'il est encore temps, et de
  // laisser une porte ouverte à quelqu'un qui est peut-être simplement furieux
  // contre une situation réelle.
  abus_avertissement:
    'Je comprends que vous soyez en colère, et je veux bien vous aider — mais pas ' +
    'avec ce vocabulaire. Les insultes et les menaces peuvent entraîner la suspension ' +
    'de votre compte. Dites-moi ce qui ne va pas et je regarde ce que je peux faire.',

  // Après le signalement. On le lui dit : elle le verra apparaître dans ses
  // réclamations, et l'apprendre de moi vaut mieux que de le découvrir là-bas.
  abus_signale:
    "J'ai signalé cet échange à l'équipe, qui va le regarder. Vous retrouverez le " +
    'dossier dans *Réclamations*. Je reste disponible pour vos questions sur Rabotka, ' +
    'dès que le ton redescend.',
};

export function refusal(id: RefusalId): string {
  return REFUSALS[id];
}

export function isRefusalId(value: string): value is RefusalId {
  return value in REFUSALS;
}
