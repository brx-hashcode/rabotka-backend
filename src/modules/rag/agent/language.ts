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

/**
 * The language a message actually shows, or `null` when it shows neither.
 *
 * The distinction matters. « ok », « merci », « 👍 », « 2 » and « RB-2043 »
 * carry no evidence at all, and treating "no evidence" as "French" is what let
 * a single « ok » switch an English conversation into French mid-thread. A tie
 * is not a French message; it is an unanswered question, and the caller has
 * history it can ask instead.
 */
export function detectLanguageOrNull(text: string): ReplyLanguage | null {
  const words = foldText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  const english = words.filter((w) => ENGLISH_MARKERS.includes(w)).length;
  const french = words.filter((w) => FRENCH_MARKERS.includes(w)).length;

  if (english === french) return null;
  return english > french ? 'en' : 'fr';
}

export function detectLanguage(text: string): ReplyLanguage {
  // French wins ties, and wins outright when nothing matches: answering a
  // Congolese user in English because their message was too short to classify
  // is a worse error than the reverse.
  return detectLanguageOrNull(text) ?? 'fr';
}

/**
 * Which language to answer in, given the conversation so far.
 *
 * The current message decides whenever it can — someone who writes a sentence
 * in French is answered in French, whatever came before. Only when it carries
 * no evidence does history break the tie, reading back through the user's own
 * turns for the last one that did.
 *
 * Only USER turns count. The assistant's replies are downstream of this same
 * function, so letting them vote would make the language self-reinforcing: one
 * wrong guess would justify itself for the rest of the conversation.
 */
export function resolveLanguage(
  text: string,
  history: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }> = [],
): ReplyLanguage {
  const fromMessage = detectLanguageOrNull(text);
  if (fromMessage) return fromMessage;

  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.role !== 'user') continue;
    const fromHistory = detectLanguageOrNull(turn.text);
    if (fromHistory) return fromHistory;
  }

  return 'fr';
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
  // The English directive used to say «translate whatever you use from it …
  // not one sentence, not one word». Taken literally — and it was — that turns
  // *Mes candidatures* into "My applications", a screen that does not exist,
  // and sends the reader looking for it. Some French is REQUIRED in an English
  // reply: the app is in French, and its labels are what the user must tap.
  //
  // So the rule is no longer "no French"; it is "no French PROSE".
  return language === 'en'
    ? [
        'ANSWER ENTIRELY IN ENGLISH. The Rabotka documentation below is written in French: put what you use from it into your own English words, never a French sentence.',
        'But NEVER translate these — they are what the user reads on screen and types, and a translated one sends them looking for something that does not exist. Keep them exactly as written, in French:',
        '- screen names (*Mes candidatures*, *Publier une mission*, *Portefeuille*…);',
        '- the names of job domains;',
        '- any word the user has to type (*payer*, *support*);',
        '- the currency, always FCFA.',
        'So « Open *Mes candidatures* to see where each one stands. » is exactly right. Address the user as "you".',
      ].join('\n')
    : "RÉPONDS ENTIÈREMENT EN FRANÇAIS. Jamais un mot d'anglais, jamais deux langues dans la même réponse. Vouvoie l'utilisateur dans chaque phrase.";
}
