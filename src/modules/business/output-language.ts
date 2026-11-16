import {
  detectLanguageOrNull,
  type ReplyLanguage,
} from '../rag/agent/language';

/**
 * The language the AI writes in for a business: the language of what it is
 * about. A job posted in English gets its CV analyses, applicant scores and
 * interview reports in English; a French one, in French, whatever language
 * the screen is in. French when nothing tells.
 */
export type OutputLanguage = ReplyLanguage;

/** Words a recruiter's short question is made of, beyond the shared markers. */
const FRENCH_WORDS = new Set(
  'quels quelles ses son sa il elle lui ils elles leur au aux du sont ont peut doit atouts parcours'.split(
    ' ',
  ),
);
const ENGLISH_WORDS = new Set(
  'his her he she they their which who has have strengths weaknesses background fit should'.split(
    ' ',
  ),
);

/**
 * The language a text shows, or null. The shared marker words first; failing
 * them, a recruiter's question words, an accented letter or French
 * punctuation (« ? » after a space): « Quels sont ses atouts ? » carries no
 * shared marker, and the questions are often that short.
 */
export function languageOf(text: string): OutputLanguage | null {
  const marked = detectLanguageOrNull(text);
  if (marked) return marked;
  const words = text.toLowerCase().match(/[a-zà-ÿœ'-]+/g) ?? [];
  const fr = words.filter((w) => FRENCH_WORDS.has(w)).length;
  const en = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  if (fr !== en) return fr > en ? 'fr' : 'en';
  if (/[àâçéèêëîïôûùœ]/i.test(text) || /\s[?!:;]/.test(text)) return 'fr';
  return null;
}

/** The language of the first text that shows one (a job's title and text, then the next…); French otherwise. */
export function writtenIn(
  ...texts: (string | null | undefined)[]
): OutputLanguage {
  return shownIn(...texts) ?? 'fr';
}

/** The same, or null when no text tells: the caller has a better fallback than French. */
export function shownIn(
  ...texts: (string | null | undefined)[]
): OutputLanguage | null {
  for (const text of texts) {
    if (!text?.trim()) continue;
    const language = languageOf(text);
    if (language) return language;
  }
  return null;
}

/**
 * A system prompt for this language. French: the prompt as written. English:
 * its French-only lines changed, and the language rule last, written in
 * English (a French instruction to answer in English is too often ignored).
 */
export function promptIn(
  prompt: string,
  language: OutputLanguage,
  english: { replace?: [string, string][]; directive: string },
): string {
  if (language === 'fr') return prompt;
  let out = prompt;
  for (const [from, to] of english.replace ?? []) {
    if (!out.includes(from)) {
      throw new Error(`promptIn: "${from.slice(0, 60)}" is not in the prompt`);
    }
    out = out.replaceAll(from, to);
  }
  return `${out}\n\n${english.directive}`;
}
