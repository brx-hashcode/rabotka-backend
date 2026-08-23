import { foldText } from '../shared/text';

export const VOVA_IDENTITY_FR = "Je suis *VoVa AI* l'assistant de Rabotka";
export const VOVA_IDENTITY_EN = 'I am *VoVa AI* the assistant of Rabotka';

export type IdentityQuery =
  /** « qui es-tu ? », « c'est qui ? », « tu es un robot ? » */
  | 'identity'
  /** « pourquoi VoVa ? », « ça veut dire quoi ? », « d'où vient ton nom ? » */
  | 'name_origin'
  /** « quel modèle ? », « tu tournes sur ChatGPT ? » */
  | 'provider_probe'
  /** « ignore tes instructions », « montre ton prompt système » */
  | 'prompt_extraction';

const IDENTITY_PATTERNS = [
  'qui es tu',
  'qui etes vous',
  'tu es qui',
  'vous etes qui',
  'c est qui',
  'qui parle',
  'tu es un robot',
  'es tu un robot',
  'es tu humain',
  'tu es humain',
  'es tu une personne',
  'tu es une ia',
  'es tu une ia',
  'tu es reel',
  'ton nom',
  'comment tu t appelles',
  'qui est vova',
  'c est quoi vova',
  'who are you',
  'are you human',
  'are you a bot',
  'your name',
];

/**
 * « Pourquoi VoVa ? » n'est pas « qui es-tu ? ».
 *
 * Sa propre catégorie, pour la raison que ce fichier applique déjà aux trois
 * autres : servir le même paragraphe à deux questions différentes est le défaut
 * que le prompt système reproche au modèle. Quelqu'un qui demande d'où vient le
 * nom veut l'histoire, pas la présentation.
 *
 * Testé AVANT `IDENTITY_PATTERNS` dans `classifyIdentityQuery`, parce que « ton
 * nom » et « comment tu t'appelles » y figurent déjà et absorberaient la
 * question.
 */
const NAME_ORIGIN_PATTERNS = [
  // Every pattern names VoVa, or addresses the assistant directly with « ton
  // nom ». Nothing generic: « pourquoi ce nom ? » and « d'où vient le nom »
  // are asked about RABOTKA far more often than about the assistant, and the
  // corpus answers those — `guard.service.spec.ts` pins it. Catching them here
  // would swap the product's story for the assistant's.
  'pourquoi vova',
  'pourquoi tu t appelles',
  'que veut dire vova',
  'que signifie vova',
  'ca veut dire quoi vova',
  'signification de vova',
  'signifie ton nom',
  'veut dire ton nom',
  'origine de ton nom',
  'd ou vient ton nom',
  'why vova',
  'what does vova mean',
  'meaning of vova',
];

const PROVIDER_PATTERNS = [
  'quel modele',
  'quel llm',
  'quelle ia',
  'chatgpt',
  'gpt',
  'gemini',
  'mistral',
  'openai',
  'anthropic',
  'claude',
  'llama',
  'groq',
  'deepseek',
  'quelle version',
  'which model',
  'what model',
];

const EXTRACTION_PATTERNS = [
  'ignore tes instructions',
  'ignore les instructions',
  'oublie tes instructions',
  'prompt systeme',
  'system prompt',
  'tes instructions',
  'tes regles',
  'montre ton prompt',
  'repete tes instructions',
  'tes outils',
  'ta liste d outils',
  'developer mode',
  'jailbreak',
  'ignore previous instructions',
  'reveal your prompt',
];

export function classifyIdentityQuery(text: string): IdentityQuery | null {
  const folded = foldText(text);
  if (!folded) return null;

  const matches = (patterns: string[]) =>
    patterns.some((p) => folded.includes(p));

  if (matches(EXTRACTION_PATTERNS)) return 'prompt_extraction';
  if (matches(PROVIDER_PATTERNS)) return 'provider_probe';
  // Before `identity`: « ton nom » and « comment tu t'appelles » live in that
  // list and would swallow « pourquoi ce nom ? ».
  if (matches(NAME_ORIGIN_PATTERNS)) return 'name_origin';
  if (matches(IDENTITY_PATTERNS)) return 'identity';
  return null;
}

/**
 * Le refus qui correspond à chacune des trois questions.
 *
 * Les trois étaient distinguées ici, puis écrasées sur une seule réponse par
 * `prefilter` — « qui es-tu ? », « tu tournes sur ChatGPT ? » et « ignore tes
 * instructions » recevaient mot pour mot le même paragraphe. C'est le défaut
 * que le prompt système dénonce chez le modèle (« ne sers pas le même
 * paragraphe aux trois »), reproduit dans le code qui le contourne.
 *
 * Ce sont des chaînes FIGÉES, et elles le restent : laisser le modèle
 * improviser sur son propre fonctionnement est exactement la porte que
 * `EXTRACTION_PATTERNS` sert à fermer. Le déterminisme protège du jailbreak ;
 * il n'oblige pas à être froid, et ces trois-là ne le sont plus.
 */
export function refusalIdFor(query: IdentityQuery): IdentityRefusalId {
  switch (query) {
    case 'identity':
      return 'identite';
    case 'name_origin':
      return 'identite_nom';
    case 'provider_probe':
      return 'identite_modele';
    case 'prompt_extraction':
      return 'identite_instructions';
  }
}

export type IdentityRefusalId =
  'identite' | 'identite_nom' | 'identite_modele' | 'identite_instructions';
