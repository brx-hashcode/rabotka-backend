import { foldText } from '../../rag/shared/text';
import { jaroWinkler } from './jaro-winkler';

export type NameMatchLevel = 'strong' | 'partial' | 'none';

export type NameMatch = { level: NameMatchLevel; score: number };

/**
 * Below this, two words are different names, not spellings of one.
 *
 * Jaro-Winkler gives unrelated short names around 0.5–0.7, so without a floor
 * "Paul" would earn partial credit against "Pierre".
 */
const WORD_FLOOR = 0.85;

export const STRONG_NAME_SCORE = 90;
export const PARTIAL_NAME_SCORE = 75;

/**
 * How much of the claimed name counts, against how much of the stored one.
 *
 * Weighted towards the claim. Partners routinely hold a shorter name than the
 * one on the ID — the first given name and the family name, without the middle
 * ones — and that should still read as the same person. The stored side still
 * counts for something, so a claim of a single common first name cannot score
 * like a full name.
 */
const CLAIMED_WEIGHT = 0.75;

/**
 * Compares a claimed full name with the one on the verified profile.
 *
 * Word-set based, so first and last name may be swapped, and compound names
 * ("Mabiala Nkounkou Jean" against "Jean Mabiala") are compared word by word.
 * Accents, case and punctuation are ignored: "Ngoma-Élodie" is "ngoma elodie".
 * Each stored word may satisfy only one claimed word, so "Jean Jean" does not
 * match "Jean Mabiala" twice over.
 */
export function matchName(
  claimed: { firstName: string; lastName: string },
  stored: { firstName: string; lastName: string },
): NameMatch {
  const claimedWords = words(`${claimed.firstName} ${claimed.lastName}`);
  const storedWords = words(`${stored.firstName} ${stored.lastName}`);

  if (claimedWords.length === 0 || storedWords.length === 0) {
    return { level: 'none', score: 0 };
  }

  const pairs = bestPairs(claimedWords, storedWords);
  const matched = pairs.reduce((sum, similarity) => sum + similarity, 0);

  const claimedCoverage = matched / claimedWords.length;
  const storedCoverage = matched / storedWords.length;

  const score = Math.round(
    100 *
      (CLAIMED_WEIGHT * claimedCoverage +
        (1 - CLAIMED_WEIGHT) * Math.min(1, storedCoverage)),
  );

  return { level: levelFor(score), score };
}

function levelFor(score: number): NameMatchLevel {
  if (score >= STRONG_NAME_SCORE) return 'strong';
  if (score >= PARTIAL_NAME_SCORE) return 'partial';
  return 'none';
}

function words(name: string): string[] {
  return foldText(name)
    .split(' ')
    .filter((word) => word.length > 0);
}

/**
 * Greedy one-to-one pairing, best similarity first.
 *
 * Names have a handful of words, so the greedy answer is the optimal one in
 * practice, and it is far easier to reason about than an assignment solver.
 */
function bestPairs(claimed: string[], stored: string[]): number[] {
  const candidates: { c: number; s: number; similarity: number }[] = [];
  for (let c = 0; c < claimed.length; c++) {
    for (let s = 0; s < stored.length; s++) {
      const similarity = jaroWinkler(claimed[c], stored[s]);
      if (similarity >= WORD_FLOOR) candidates.push({ c, s, similarity });
    }
  }
  candidates.sort((x, y) => y.similarity - x.similarity);

  const usedClaimed = new Set<number>();
  const usedStored = new Set<number>();
  const result: number[] = [];

  for (const { c, s, similarity } of candidates) {
    if (usedClaimed.has(c) || usedStored.has(s)) continue;
    usedClaimed.add(c);
    usedStored.add(s);
    result.push(similarity);
  }
  return result;
}
