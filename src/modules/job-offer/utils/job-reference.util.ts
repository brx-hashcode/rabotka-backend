import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const REFERENCE_REGEX = /^RAB-[A-HJ-NP-Z2-9]{5}$/;

export function generateJobReference(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return `RAB-${code}`;
}

export function normalizeJobReference(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidReferenceShape(s: string): boolean {
  return REFERENCE_REGEX.test(s);
}
