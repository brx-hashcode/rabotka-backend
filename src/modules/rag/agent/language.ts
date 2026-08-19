import { foldText } from '../shared/text';

export type ReplyLanguage = 'fr' | 'en';

/**
 * Which language to answer in.
 *
 * Rabotka is French-first and the corpus is French, so French is the default
 * and English is the exception rather than a full second locale.
 *
 * The detection is a word count rather than a library: the messages are short,
 * the two languages are far apart, and a dependency for this would be a
 * supply-chain risk bought to tell « bonjour » from « hello ».
 */
const ENGLISH_MARKERS = [
  'the',
  'you',
  'your',
  'how',
  'what',
  'can',
  'do',
  'does',
  'want',
  'need',
  'find',
  'work',
  'worker',
  'job',
  'hire',
  'help',
  'please',
  'thanks',
  'thank',
  'where',
  'when',
  'why',
  'is',
  'are',
  'my',
  'me',
  'i',
  'we',
  'and',
  'with',
  'speak',
  'english',
  'verified',
  'account',
  'money',
  'pay',
];

const FRENCH_MARKERS = [
  'le',
  'la',
  'les',
  'je',
  'vous',
  'tu',
  'est',
  'et',
  'un',
  'une',
  'des',
  'comment',
  'pourquoi',
  'quoi',
  'que',
  'qui',
  'pour',
  'avec',
  'dans',
  'sur',
  'mon',
  'ma',
  'mes',
  'votre',
  'travail',
  'mission',
  'bonjour',
  'merci',
  'combien',
  'quel',
  'quelle',
  'ça',
  'ca',
  'suis',
  'veux',
];

export function detectLanguage(text: string): ReplyLanguage {
  const words = foldText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'fr';

  const english = words.filter((w) => ENGLISH_MARKERS.includes(w)).length;
  const french = words.filter((w) => FRENCH_MARKERS.includes(w)).length;

  // French wins ties, and wins outright when nothing matches: answering a
  // Congolese user in English because their message was too short to classify
  // is a worse error than the reverse.
  return english > french ? 'en' : 'fr';
}

/**
 * The language instruction, written IN the target language.
 *
 * A French instruction telling a model to answer in English is followed about
 * as often as it is ignored — production produced a reply that opened in
 * English and finished in French, mid-paragraph. Stating the rule in the
 * language it is asking for is markedly more reliable, and costs nothing.
 */
export function languageDirective(language: ReplyLanguage): string {
  return language === 'en'
    ? 'ANSWER ENTIRELY IN ENGLISH. The Rabotka documentation below is written in French: translate whatever you use from it. Never mix English and French in one reply — not one sentence, not one word. Address the user as "you".'
    : "RÉPONDS ENTIÈREMENT EN FRANÇAIS. Jamais un mot d'anglais, jamais deux langues dans la même réponse. Vouvoie l'utilisateur dans chaque phrase.";
}
