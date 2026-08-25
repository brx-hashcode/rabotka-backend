import { randomInt } from 'node:crypto';

/**
 * Alphabet for parrainage codes.
 *
 * Deliberately not base36. These codes are read aloud in WhatsApp voice notes
 * and typed on phone keyboards by people who did not choose them, so the
 * lookalike pairs are the failure that actually happens: `0`/`O` and `1`/`I`
 * are excluded, both members of each pair. `L` stays — it is only confusable
 * with `1` and a lowercase `l`, and neither can appear here.
 *
 * 32 symbols ** 6 positions ≈ 1.07e9 — far past what a throttled endpoint can
 * be walked through, and short enough to dictate over a phone call.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;

/** Matches what {@link generateReferralCode} emits. Shared with the DTO. */
export const REFERRAL_CODE_PATTERN = /^[2-9A-HJ-NP-Z]{6}$/;

export function generateReferralCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    // randomInt, not Math.random: these are guessable identifiers that grant
    // money, and the cost of a CSPRNG here is nothing.
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/**
 * Normalise a code as a human typed it before comparing it to a stored one.
 *
 * Users paste codes with a trailing space out of a WhatsApp message, type them
 * in lowercase, and add the dash they saw in the marketing copy. All three are
 * the same code. Returns null for anything that could not be one, so callers
 * can treat "malformed" and "unknown" identically — both mean no parrainage,
 * neither means a failed signup.
 */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return REFERRAL_CODE_PATTERN.test(cleaned) ? cleaned : null;
}
