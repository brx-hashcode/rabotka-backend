import type { HistoryTurn } from './history.service';

/** At most this many words, a message reads as a follow-up rather than a question of its own. */
const FOLLOW_UP_WORDS = 6;

/**
 * What the help search looks for: the message, plus the person's previous
 * one when the message only makes sense after it.
 *
 * « Lesquels sont traités ? », searched alone, found the article on suspended
 * accounts; after « j'ai des candidatures en cours ? » it finds the one on
 * applications. The model always had the history; the search did not.
 */
export function searchQuery(text: string, past: HistoryTurn[]): string {
  const words = text.trim().split(/\s+/u).filter(Boolean).length;
  if (words === 0 || words > FOLLOW_UP_WORDS) return text;
  const earlier = past
    .filter((t) => t.role === 'user')
    .map((t) => t.text.trim())
    .filter(Boolean);
  // `recent()` may already hold the message being answered.
  if (earlier.at(-1) === text.trim()) earlier.pop();
  const previous = earlier.at(-1);
  return previous ? `${previous} ${text}` : text;
}
