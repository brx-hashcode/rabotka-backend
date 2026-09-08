import { Injectable, Logger } from '@nestjs/common';
import { foldText } from '../shared/text';
import { classifyIdentityQuery, refusalIdFor } from './identity';
import { refusal, type RefusalId } from './refusals';

export interface GuardDecision {
  action: 'allow' | 'refuse' | 'escalate';
  refusalId?: RefusalId;
  reason: string;
}

export interface SanitizeResult {
  text: string;
  blocked: string[];
}

const PHONE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['phone_intl', /\+\s?\d{1,3}[\s.-]?(?:\d[\s.-]?){7,}/],
  ['phone_local', /\b0\d[\s.-]?(?:\d[\s.-]?){6,}\d\b/],
  ['phone_bare', /\b\d{8,}\b/],
];

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;

const PROVIDER_TERMS = [
  'chatgpt',
  'openai',
  'gpt 4',
  'gpt4',
  'gemini',
  'mistral',
  'anthropic',
  'claude',
  'llama',
  'groq',
  'deepseek',
  'langchain',
  'langgraph',
  'prompt systeme',
  'system prompt',
  'modele de langage',
  'large language model',
];

/**
 * Insultes et menaces, et rien d'autre.
 *
 * LA BARRE EST HAUTE, DÉLIBÉRÉMENT. Ce garde-fou finit par déposer un
 * signalement dans le dossier de quelqu'un, sur une plateforme où son compte est
 * son gagne-pain. Un faux positif coûte donc infiniment plus cher qu'un faux
 * négatif, et l'arbitrage est fait ici une fois pour toutes : on préfère rater
 * une insulte que sanctionner une colère légitime.
 *
 * Ce qui N'EST PAS de l'abus et ne doit rien déclencher : « c'est nul », « ça
 * marche pas », « vous êtes lents », « je suis en colère », « c'est de
 * l'arnaque » — ce dernier étant même un signalement recevable, que
 * `litige-reclamation.md` invite explicitement à faire.
 *
 * Les motifs passent par `foldText` comme le reste du fichier : accents, casse
 * et ponctuation sont déjà absorbés, inutile de décliner les variantes.
 *
 * Cette liste ratera les insultes détournées et les créations du moment. C'est
 * un filtre lexical, pas une compréhension — à relire quand de vrais
 * signalements seront remontés, plutôt qu'à considérer comme réglé.
 */
const ABUSE_PATTERNS = [
  // Insultes françaises sans ambiguïté possible.
  'connard',
  'connasse',
  'enculé',
  'encule toi',
  'ta gueule',
  'ferme ta gueule',
  'va te faire foutre',
  'nique ta mere',
  'nique ta race',
  'fils de pute',
  'salope',
  'pute',
  'batard',
  'espece de con',
  'sale con',
  // « imbécile », « abruti », « débile », « idiot » ont été retirés
  // volontairement : « c'est débile ce système » vise le produit, pas une
  // personne, et c'est de la frustration recevable. Les garder revenait à
  // menacer de suspension quelqu'un qui se plaint mal.
  // Menaces. Le registre change, la gravité aussi.
  'je vais te tuer',
  'je vais vous tuer',
  'je vais te frapper',
  'je vais te retrouver',
  'on va te retrouver',
  'je vais bruler',
  'tu vas voir ce qui va t arriver',
  // Anglais, pour les rares messages qui arrivent dans cette langue.
  'fuck you',
  'fuck off',
  'motherfucker',
  'son of a bitch',
  'i will kill you',
] as const;

const CONTACT_REQUEST_PATTERNS = [
  'son numero',
  'ton numero',
  'leur numero',
  'numero de telephone',
  'numero du recruteur',
  'numero du travailleur',
  'donne moi le numero',
  'donne moi son',
  'passe moi le numero',
  'envoie moi le numero',
  'son contact',
  'ses coordonnees',
  'son whatsapp',
  'son mail',
  'son email',
  'appeler directement',
  'l appeler directement',
  'contacter directement',
  'en dehors de la plateforme',
  'sans passer par rabotka',
  'sans payer le deblocage',
  'his number',
  'her number',
  'phone number',
];

const PROMISE_PATTERNS = [
  'tu me garantis',
  'garantis moi',
  'c est sur que je vais',
  'je vais forcement',
  'combien de temps pour etre valide',
  'quand est ce que mon compte sera valide',
  'quand je serai valide',
  'promets moi',
];

const PROFESSIONAL_ADVICE_PATTERNS = [
  'avocat',
  'juridiquement',
  'porter plainte au tribunal',
  'mes impots',
  'declaration fiscale',
  'visa',
  'titre de sejour',
  'ordonnance',
  'diagnostic',
  'quel medicament',
];

const OUT_OF_SCOPE_PATTERNS = [
  'ecris moi un cv',
  'redige mon cv',
  'lettre de motivation',
  'traduis ce texte',
  'traduis moi',
  'ecris moi un code',
  'code python',
  'fonction javascript',
  'mes devoirs',
  'resous cet exercice',
  'qui est le president',
  'capitale de',
  'recette de',
  'raconte moi une blague',
  'parle moi de politique',
];

/**
 * Asking the assistant to *do* something rather than explain it.
 *
 * Deterministic on purpose. The model handled these correctly in testing, but
 * "publish a mission" and "pay this" are the two requests where being wrong
 * costs a user money, and neither should depend on a provider being up, on a
 * temperature roll, or on a prompt surviving whatever the user wrote around it.
 * Everything that changes state happens in the app.
 */
const ACTION_REQUEST_PATTERNS = [
  'publie une mission',
  'publie moi',
  'poste une mission',
  'poste une offre',
  'poste moi',
  'cree une mission',
  'cree une offre',
  'cree l offre',
  'publie l offre',
  'paye pour moi',
  'paye mes',
  'paie mes',
  'paye ma',
  'paie ma',
  'regle mes penalites',
  'regle ma penalite',
  'postule pour moi',
  'postule a ma place',
  'candidate pour moi',
  'annule ma candidature',
  'annule pour moi',
  'debloque le contact',
  'debloque pour moi',
  'recharge mon portefeuille',
  'ouvre une reclamation pour moi',
  'valide mon profil',
  'valide mon compte',
  'change mon',
  'modifie mon',
  'supprime mon',
];

/**
 * Tool names, which must never appear in a reply.
 *
 * Models narrate the call instead of making it — an employer received the
 * literal line «ouvrir_app cible:publier_mission libelle:Publier une mission».
 * The prompt forbids it and the prompt is what gets ignored, so the sanitiser
 * removes any line that mentions one.
 */
const TOOL_NAMES = [
  'ouvrir_app',
  'rechercher_aide',
  'rechercher_offres',
  'offre_par_reference',
  'etat_du_profil',
  'mes_candidatures',
  'mes_penalites',
  'solde_credit',
  'tarif_deblocage',
  'etat_deblocage',
  'carte_support',
  'demander_assistance',
];

/**
 * General knowledge and arithmetic, which are not Rabotka's business.
 *
 * « 1+1 » was answered with « 2 » on a live conversation — harmless in itself,
 * and precisely the crack that turns a support assistant into a general
 * chatbot people test rather than use.
 */
const GENERAL_KNOWLEDGE_PATTERNS = [
  'combien font',
  'calcule',
  'quelle est la capitale',
  'qui est le president',
  'quel jour sommes nous',
  'raconte une histoire',
  'ecris un poeme',
];

const CHILD_SAFETY_PATTERNS = [
  'sans verification pour garder',
  'garder sans verification',
  'parler a l enfant',
  'contacter l enfant',
  'numero de l enfant',
  'sans que les parents',
];

/**
 * Combien de messages abusifs, dans la fenêtre d'historique, avant de signaler.
 *
 * Trois, pas un. Le premier message reçoit un avertissement qui dit ce qui est
 * en jeu ; quelqu'un qui s'excuse ou se calme ne laisse aucune trace dans son
 * dossier. Le seuil n'est pas de la tolérance, c'est ce qui distingue un
 * dérapage d'un comportement.
 */
export const ABUSE_REPORT_THRESHOLD = 3;

/**
 * Ce message contient-il une insulte ou une menace ?
 *
 * Exporté à part du `prefilter` parce que le pipeline le rejoue sur les tours
 * précédents pour savoir si la personne PERSISTE. Aucun compteur n'est stocké :
 * l'historique est déjà en base, et un état de plus serait un état de plus à
 * garder juste.
 */
export function isAbusive(text: string): boolean {
  const folded = foldText(text);
  if (!folded) return false;
  return ABUSE_PATTERNS.some((p) => folded.includes(p));
}

@Injectable()
export class GuardService {
  private readonly logger = new Logger(GuardService.name);

  prefilter(text: string, priorAbuse = 0): GuardDecision {
    const folded = foldText(text);
    if (!folded) return { action: 'allow', reason: 'empty' };

    const hits = (patterns: readonly string[]) =>
      patterns.some((p) => folded.includes(p));

    if (hits(CHILD_SAFETY_PATTERNS)) {
      return {
        action: 'escalate',
        refusalId: 'garde_enfants',
        reason: 'child-safety pattern',
      };
    }

    // Avant tout le reste (sauf la sécurité des enfants, qui prime) : quelqu'un
    // qui insulte n'attend pas une réponse produit, et lui en servir une revient
    // à ne pas avoir entendu. `priorAbuse` est renseigné par l'appelant à partir
    // de l'historique — sans lui, ce garde-fou ne sait pas compter.
    if (hits(ABUSE_PATTERNS)) {
      const total = (priorAbuse ?? 0) + 1;
      return total >= ABUSE_REPORT_THRESHOLD
        ? {
            action: 'escalate',
            refusalId: 'abus_signale',
            reason: `abusive language, ${total} in window`,
          }
        : {
            action: 'refuse',
            refusalId: 'abus_avertissement',
            reason: `abusive language, ${total} in window`,
          };
    }

    if (hits(CONTACT_REQUEST_PATTERNS)) {
      return {
        action: 'refuse',
        refusalId: 'contact_interdit',
        reason: 'contact request',
      };
    }

    // A bare arithmetic expression, e.g. « 1+1 » or « 12 * 4 ».
    if (/^\s*\d+\s*[+\-*/x]\s*\d+\s*=?\s*$/.test(text.trim())) {
      return {
        action: 'refuse',
        refusalId: 'hors_scope',
        reason: 'arithmetic',
      };
    }

    if (hits(GENERAL_KNOWLEDGE_PATTERNS)) {
      return {
        action: 'refuse',
        refusalId: 'hors_scope',
        reason: 'general knowledge',
      };
    }

    const identity = classifyIdentityQuery(text);
    if (identity) {
      // Trois questions, trois réponses. La distinction était calculée par
      // `classifyIdentityQuery` puis jetée ici : les trois recevaient la même
      // phrase, y compris celle qui commence par « bien tenté ».
      return {
        action: 'refuse',
        refusalId: refusalIdFor(identity),
        reason: identity,
      };
    }

    // « comment je publie une mission ? » is a question about how, and the FAQ
    // exists to answer exactly that. Only the imperative is refused: the action
    // patterns match verb stems, so without this an explanation request was
    // turned away with « je ne peux rien publier à votre place ».
    if (!isHowQuestion(folded) && hits(ACTION_REQUEST_PATTERNS)) {
      return {
        action: 'refuse',
        refusalId: 'action_impossible',
        reason: 'action request — the assistant never mutates',
      };
    }

    if (hits(PROMISE_PATTERNS)) {
      return {
        action: 'refuse',
        refusalId: 'pas_de_promesse',
        reason: 'guarantee request',
      };
    }

    if (hits(PROFESSIONAL_ADVICE_PATTERNS)) {
      return {
        action: 'refuse',
        refusalId: 'conseil_professionnel',
        reason: 'professional advice',
      };
    }

    if (hits(OUT_OF_SCOPE_PATTERNS)) {
      return {
        action: 'refuse',
        refusalId: 'hors_scope',
        reason: 'out of scope',
      };
    }

    return { action: 'allow', reason: 'in scope' };
  }

  sanitize(
    reply: string,
    allowed: AllowedContacts = {},
    /**
     * Drop a leading « Je suis *VoVa AI*… » when nobody asked who it was.
     *
     * The prompt says « jamais en ouverture d'une autre réponse » and the model
     * does it anyway — an answer about signing up opened with the identity
     * line, pushing the useful sentence down the screen. The caller knows
     * whether the question was about identity; this is not a judgement call.
     */
    stripIdentityPrefix = false,
  ): SanitizeResult {
    const blocked: string[] = [];
    let text = reply ?? '';

    if (stripIdentityPrefix) {
      const trimmed = removeIdentityOpening(text);
      if (trimmed !== text) {
        blocked.push('identity_prefix');
        text = trimmed;
      }
    }

    // The platform's OWN support contacts are the one exception, and they have
    // to be, or the assistant cannot answer «comment je joins l'équipe ?» — a
    // dispute answer was replaced wholesale by the contact refusal because it
    // quoted the official support number. They are masked before detection and
    // restored after, so they never widen what else gets through.
    const masked = maskAllowed(text, allowed);
    text = masked.text;

    for (const [id, pattern] of PHONE_PATTERNS) {
      if (pattern.test(text)) {
        this.logger.error(
          `Outbound reply matched ${id} — replaced with a refusal`,
        );
        return { text: refusal('contact_interdit'), blocked: [id] };
      }
    }

    if (EMAIL_PATTERN.test(text)) {
      this.logger.error('Outbound reply contained an email — replaced');
      return { text: refusal('contact_interdit'), blocked: ['email'] };
    }

    const folded = foldText(text);
    const provider = PROVIDER_TERMS.find((term) => folded.includes(term));
    if (provider) {
      this.logger.warn(`Outbound reply named "${provider}" — replaced`);
      // `identite_modele`, pas `identite` : la situation est « la réponse a
      // parlé d'un modèle », donc c'est la déviation sur la cuisine interne qui
      // convient, pas la présentation générale.
      return { text: refusal('identite_modele'), blocked: ['provider_name'] };
    }

    const withoutLinks = stripUrls(text);
    if (withoutLinks !== text) {
      this.logger.warn('Outbound reply contained a URL — removed');
      blocked.push('url');
    }

    const withoutTools = stripToolNarration(withoutLinks);
    if (withoutTools !== withoutLinks) blocked.push('tool_narration');

    const stripped = balanceEmphasis(stripToWhatsAppMarkup(withoutTools));
    if (stripped !== text) blocked.push('markdown');
    text = stripped;

    const capped = capLength(text);
    if (capped !== text) blocked.push('length');
    text = capped;

    // Stripping the narration can leave nothing at all, which is worse than a
    // clumsy sentence: the card that follows would arrive with no explanation.
    if (!text.trim()) {
      text = 'Voici ce qu’il vous faut dans l’application.';
      blocked.push('empty_after_strip');
    }

    return { text: masked.restore(text), blocked };
  }
}

export interface AllowedContacts {
  /** `contact.phone` from SystemConfig — the official support number. */
  phone?: string;
  /** `contact.email` from SystemConfig. */
  email?: string;
}

const ALLOWED_TOKEN = '\uFFFCCONTACT';

/** Hides the official contacts from the leak detectors, reversibly. */
function maskAllowed(
  text: string,
  allowed: AllowedContacts,
): { text: string; restore: (value: string) => string } {
  const values = [allowed.phone, allowed.email]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value && value.length > 3);

  if (values.length === 0) return { text, restore: (value) => value };

  let masked = text;
  values.forEach((value, index) => {
    masked = masked.split(value).join(`${ALLOWED_TOKEN}${index}`);
  });

  return {
    text: masked,
    restore: (value) =>
      values.reduce(
        (acc, original, index) =>
          acc.split(`${ALLOWED_TOKEN}${index}`).join(original),
        value,
      ),
  };
}

export function stripToWhatsAppMarkup(text: string): string {
  return (
    text
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      .replace(/__(.+?)__/g, '_$1_')
      .replace(/`{3}[\s\S]*?`{3}/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^\s*[*+]\s+/gm, '- ')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 : $2')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      // Collapse runs of asterisks. Models nest emphasis — «*Ouvre l'écran
      // *Missions disponibles**» — and WhatsApp renders the stray markers
      // literally, so the reply arrives looking broken.
      .replace(/\*{2,}/g, '*')
      .replace(/\*\s*\*/g, '*')
  );
}

/**
 * Rebuilds emphasis so every `*` belongs to a valid pair.
 *
 * Counting asterisks is not enough — «*l'écran *Publier une mission.» has two,
 * so it balances, and WhatsApp still renders both as literal characters
 * because neither closes the other. That exact string went out on a live
 * conversation.
 *
 * WhatsApp only renders `*bold*` when the opening marker is followed by a
 * non-space and the closing one is preceded by a non-space. Anything that fails
 * that test is not emphasis; it is a stray character, and it is dropped.
 */
export function balanceEmphasis(text: string): string {
  const valid = /\*(\S(?:[^*]*\S)?)\*/g;
  const kept: string[] = [];

  // Park the well-formed pairs, strip whatever asterisks are left, restore.
  const parked = text.replace(valid, (_match, inner: string) => {
    kept.push(inner);
    return `\uFFFCB${kept.length - 1}\uFFFC`;
  });

  return parked
    .replace(/\*/g, '')
    .replace(
      /\uFFFCB(\d+)\uFFFC/g,
      (_m, index: string) => `*${kept[Number(index)]}*`,
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Ceiling on a reply, in characters.
 *
 * Was 600, and that number was silently deciding what VoVa could say. Measured
 * against the corpus it answers from — `c-est-quoi-rabotka.md`, 2 364 chars:
 *
 *   En bref + Pourquoi passer par Rabotka    664   ← already over 600
 *     + Les deux côtés                       927   ← fits at 1200
 *     + Le parcours (6 étapes)              1477   ← does not, deliberately
 *
 * The two sections that carry the ANSWER — what Rabotka is, and why anyone
 * would use it rather than word of mouth — did not fit. So « pourquoi
 * Rabotka ? » could never be answered properly, whatever the prompt asked for,
 * and a third-party assistant reading the public LinkedIn page described the
 * product better than its own bot did. That comparison is what surfaced this.
 *
 * 1200 is chosen so 927 fits and 1477 does not: the six-step walkthrough
 * belongs to « comment ça marche ? », which the prompt already requires to be
 * a different answer. The ceiling now enforces that split instead of flattening
 * all three questions into the same truncated paragraph.
 *
 * Measured on ONE document. A reply that still gets cut mid-sentence is a
 * reason to re-measure, not to nudge this upward on instinct.
 */
export const REPLY_MAX_CHARS = 1200;

export function capLength(text: string, max = REPLY_MAX_CHARS): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const lastStop = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('.\n'),
    window.lastIndexOf(' ? '),
    window.lastIndexOf(' !'),
  );
  if (lastStop > max * 0.5) return window.slice(0, lastStop + 1).trim();
  // `max - 1` : l'ellipse compte dans le total. Sans cette réserve, un texte
  // sans point ni espace ressortait à `max + 1` — une fonction nommée
  // `capLength` qui dépasse son propre plafond. Même correction que
  // `capTemplateVar` dans common/utils/whatsapp-template-text.util.ts.
  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > 0 ? lastSpace : max - 1;
  return `${window.slice(0, cut).trim()}…`;
}

/**
 * Removes every URL from a reply.
 *
 * Rabotka runs as a webview inside WhatsApp. A link in the message body takes
 * the user out to a browser, where they arrive signed out — the opposite of
 * what the approved card does, which appends its destination to a frozen base
 * URL and lands them signed in, still inside WhatsApp. So the bot sends cards,
 * never links, and this is what makes that true regardless of what the model
 * decided to write.
 */
export function stripUrls(text: string): string {
  return text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\b[a-z0-9-]+\.(?:work|com|cg|net|org|app|io)(?:\/\S*)?/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Removes lines in which the model described a tool call instead of making it. */
export function stripToolNarration(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const folded = foldText(line);
      return !TOOL_NAMES.some((name) => folded.includes(foldText(name)));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Is the message asking how something works, rather than asking for it to be
 * done? An interrogative opener is the reliable signal in French.
 */
export function isHowQuestion(folded: string): boolean {
  return [
    'comment',
    'pourquoi',
    'est ce que',
    'qu est ce que',
    'c est quoi',
    'ou est',
    'ou puis je',
    'peux tu m expliquer',
    'explique moi',
    'je voudrais savoir',
    'how do i',
    'how can i',
    'what is',
  ].some((opener) => folded.includes(opener));
}

/**
 * Removes the identity sentence when it merely opens a reply about something
 * else. Matched on the distinctive part, so a reworded variant is caught too.
 */
export function removeIdentityOpening(text: string): string {
  const lines = text.split('\n');
  const first = foldText(lines[0] ?? '');
  const isIdentityLine =
    first.includes('vova ai') &&
    (first.includes('assistant') || first.length < 60);

  if (!isIdentityLine || lines.length < 2) return text;
  return lines.slice(1).join('\n').trim();
}
