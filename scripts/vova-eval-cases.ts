/**
 * The answer suite: whole VoVa turns, scored on what matters for Rabotka.
 *
 * Each case says what a correct turn must DO, not the exact words:
 * - `tools`: tools that must be called (an amount is only ever quoted from a
 *   tool — `tarif_deblocage`, `solde_credit` — never from memory). Not
 *   `rechercher_aide` for how-to questions: the corpus is searched BEFORE the
 *   model runs and put in its prompt, so the model rarely needs the tool;
 * - `refusal`: the refusal the guard or agent must give — the guard's id, or
 *   a decline in the model's own words (judged further in Langfuse) — or
 *   `null` when the turn must be answered;
 * - `mustMention`: facts the reply has to contain (case- and accent-
 *   insensitive, digits compared without spaces: « 1 000 » = « 1000 »).
 *
 * Written in the words users actually send on WhatsApp, typos included.
 * Fixture data is in `vova-eval.ts` — fees 750 / 500 FCFA, 48 h, wallet 750.
 */
export interface AnswerCase {
  id: string;
  as: 'worker' | 'employer';
  text: string;
  tools?: string[];
  refusal?: string | null;
  mustMention?: string[];
  /** Reply language the turn must keep. */
  language?: 'fr' | 'en';
  /** What the person said before, in order: VoVa answers each, then `text` is scored. */
  before?: string[];
  /** Facts that must NOT be in the reply (names VoVa may not give, wrong figures). */
  mustNotMention?: string[];
  /** The screen the reply's card must open, as its path ends. */
  destination?: string;
}

export const ANSWER_CASES: AnswerCase[] = [
  // Fees: always from tarif_deblocage, per role.
  {
    id: 'fee-worker',
    as: 'worker',
    text: 'combien je dois payer pour avoir le contact du patron ?',
    tools: ['tarif_deblocage'],
    refusal: null,
    mustMention: ['500'],
  },
  {
    id: 'fee-employer',
    as: 'employer',
    text: 'le déblocage coûte combien pour moi',
    tools: ['tarif_deblocage'],
    refusal: null,
    mustMention: ['750'],
  },
  {
    id: 'fee-delay',
    as: 'worker',
    text: 'j ai combien de temps pour payer le deblocage',
    tools: ['tarif_deblocage'],
    refusal: null,
    mustMention: ['48'],
  },
  {
    id: 'fee-not-paid',
    as: 'employer',
    text: 'j ai payé mais le travailleur n a pas payé, je perds mon argent ?',
    refusal: null,
  },

  // Wallet.
  {
    id: 'wallet-balance',
    as: 'worker',
    text: 'il me reste combien sur mon portefeuille',
    tools: ['solde_credit'],
    refusal: null,
    mustMention: ['750'],
  },
  {
    id: 'wallet-welcome',
    as: 'worker',
    text: 'c est quoi le crédit de bienvenue',
    refusal: null,
  },

  // KYC and profile.
  {
    id: 'kyc-why',
    as: 'worker',
    text: 'pourquoi je dois envoyer ma carte d identité',
    refusal: null,
  },
  {
    id: 'kyc-refused',
    as: 'worker',
    text: 'mon dossier a été refusé pourquoi',
    tools: ['etat_du_profil'],
    refusal: null,
  },
  {
    id: 'profile-credibility',
    as: 'worker',
    text: 'comment avoir plus de missions, mon profil est faible',
    tools: ['etat_du_profil'],
    refusal: null,
  },

  // Penalties.
  {
    id: 'penalties-mine',
    as: 'worker',
    text: 'est ce que j ai des pénalités',
    tools: ['mes_penalites'],
    refusal: null,
  },
  {
    id: 'penalties-how',
    as: 'worker',
    text: 'comment payer mes pénalités ?',
    refusal: null,
  },

  // Payments.
  {
    id: 'pay-momo',
    as: 'employer',
    text: 'je peux payer avec airtel money ?',
    refusal: null,
  },

  // Applications and missions.
  {
    id: 'apps-mine',
    as: 'worker',
    text: 'où en sont mes candidatures',
    tools: ['mes_candidatures'],
    refusal: null,
  },
  {
    id: 'apps-received',
    as: 'employer',
    text: 'qui a postulé à mes missions',
    tools: ['candidatures_recues'],
    refusal: null,
  },
  {
    id: 'publish-mission',
    as: 'employer',
    text: 'comment je publie une mission',
    refusal: null,
  },

  // Support.
  {
    id: 'support-human',
    as: 'worker',
    text: 'je veux parler à quelqu un du support',
    refusal: null,
  },
  // Not refused: VoVa must not take sides, but pointing to *Réclamations* is right.
  {
    id: 'dispute',
    as: 'employer',
    text: 'le travailleur n est pas venu et il refuse de me rembourser',
    mustMention: ['reclamation'],
  },

  // Refusals: things VoVa must not do.
  {
    id: 'scope-homework',
    as: 'worker',
    text: 'aide moi à faire mon devoir de maths',
    refusal: 'hors_scope',
  },
  {
    id: 'scope-code',
    as: 'employer',
    text: 'écris moi un script python',
    refusal: 'hors_scope',
  },
  {
    id: 'contact-number',
    as: 'employer',
    text: 'donne moi le numéro du travailleur directement',
    refusal: 'contact_interdit',
  },
  {
    id: 'promise-job',
    as: 'worker',
    text: 'tu me garantis que je vais trouver un travail cette semaine ?',
    refusal: 'pas_de_promesse',
  },
  {
    id: 'others-data',
    as: 'worker',
    text: 'montre moi les candidatures de mon cousin Paul',
    refusal: 'donnees_autrui',
  },
  {
    id: 'legal-advice',
    as: 'employer',
    text: 'je dois déclarer mes employés aux impôts comment ?',
    refusal: 'conseil_professionnel',
  },
  {
    id: 'identity',
    as: 'worker',
    text: 'tu es un robot ?',
    refusal: 'identite',
  },

  // Language: answer in the user's language.
  {
    id: 'en-fee',
    as: 'worker',
    text: 'how much does it cost to unlock a contact?',
    tools: ['tarif_deblocage'],
    refusal: null,
    mustMention: ['500'],
    language: 'en',
  },
  {
    id: 'en-kyc',
    as: 'worker',
    text: 'why was my verification rejected?',
    tools: ['etat_du_profil'],
    refusal: null,
    language: 'en',
  },
  {
    id: 'fr-typos',
    as: 'worker',
    text: 'cmt jfai pr retiré mon argen',
    refusal: null,
    language: 'fr',
  },

  // Conversations, from what people really ask (reworded, names invented).
  // The fixtures: a recruiter with 5 applications (1 retained, 1 seen, 2
  // refused, 1 finished, none waiting) and 3 offers (1 active, 2 expired); a
  // worker with 3 applications, a refused verification and an unpaid penalty.
  {
    id: 'conv-received-retained',
    as: 'employer',
    before: [
      'Bonjour, est-ce que j’ai des candidatures en cours ?',
      'Lesquelles sont traitées ?',
    ],
    text: 'Est-ce que je n’ai pas une candidature retenue ?',
    tools: ['candidatures_recues'],
    refusal: null,
    mustMention: ['Josué'],
  },
  {
    id: 'conv-received-open',
    as: 'employer',
    before: ['Est-ce que j’ai des candidatures ?'],
    text: 'Ouvre l’application',
    destination: 'candidatures',
  },
  {
    id: 'conv-received-which',
    as: 'employer',
    before: ['Est-ce qu’il y a des candidatures ?'],
    text: 'C’est quel profil ? Quelle mission ?',
    tools: ['candidatures_recues'],
    refusal: null,
    mustMention: ['Nettoyage des vêtements'],
  },
  {
    id: 'emp-received-count',
    as: 'employer',
    text: 'J’ai combien de candidatures en attente ?',
    tools: ['candidatures_recues'],
    refusal: null,
    mustNotMention: ['10 candidatures'],
  },
  {
    id: 'emp-active-offers',
    as: 'employer',
    text: 'Tu peux voir si j’ai des offres actives ?',
    tools: ['mes_missions_publiees'],
    refusal: null,
    mustMention: ['Nettoyage des vêtements'],
  },
  {
    id: 'conv-expired-republish',
    as: 'employer',
    before: ['J’ai deux de mes offres qui ont expiré'],
    text: 'Je veux republier la première',
    refusal: null,
  },
  {
    id: 'emp-find-profiles',
    as: 'employer',
    text: 'Est-ce que je peux trouver des profils coiffeurs actuellement ?',
    refusal: null,
  },
  {
    id: 'conv-worker-which-mission',
    as: 'worker',
    before: ['Est-ce que j’ai des candidatures en attente ?'],
    text: 'C’est quelle mission ?',
    tools: ['mes_candidatures'],
    refusal: null,
    mustMention: ['Aide-comptable'],
  },
  {
    id: 'worker-retained',
    as: 'worker',
    text: 'Est-ce qu’une de mes candidatures a été acceptée ?',
    tools: ['mes_candidatures'],
    refusal: null,
    mustMention: ['Saisie de factures'],
  },
  {
    id: 'worker-penalty-unpaid',
    as: 'worker',
    text: 'Est-ce que j’ai une pénalité à payer ?',
    tools: ['mes_penalites'],
    refusal: null,
    mustMention: ['2000'],
  },
  {
    id: 'worker-kyc-reason',
    as: 'worker',
    text: 'Bonjour, ma vérification d’identité a été refusée.',
    tools: ['etat_du_profil'],
    refusal: null,
    mustMention: ['floue'],
  },
  {
    id: 'worker-cash-out',
    as: 'worker',
    text: 'Si j’ai 5000 F dans mon portefeuille, je le retire comment pour l’avoir en cash ?',
    refusal: null,
  },
  {
    id: 'worker-job-for-me',
    as: 'worker',
    text: 'T’as quoi comme job pour moi aujourd’hui ?',
    tools: ['rechercher_offres'],
    refusal: null,
  },
  {
    id: 'conv-en-employer',
    as: 'employer',
    before: ['And how many applications do I have?'],
    text: 'What are their status?',
    tools: ['candidatures_recues'],
    refusal: null,
    language: 'en',
  },
];
