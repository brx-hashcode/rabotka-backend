import {
  EMAIL_PATTERN,
  PHONE_PATTERNS,
} from '../../rag/agent/guard.service';

/**
 * What a withheld fragment is.
 *
 * Mirrors the Prisma enum `RedactionCategory` that lands with the schema. Kept
 * as a union here so this whole folder stays free of the database: it is pure
 * functions, testable without a connection, and that is the point of it.
 */
export type RedactionCategory =
  | 'PHONE'
  | 'EMAIL'
  | 'MESSAGING_HANDLE'
  | 'URL'
  | 'OBFUSCATED_DIGITS';

/**
 * Which text a pattern runs against.
 *
 * `raw` is the default and the common case. Phone numbers, emails, links and
 * handles are built out of `+`, `.`, `-`, `/` and `@` — the very characters
 * folding replaces with spaces — so folding first would destroy what they match
 * on. `GuardService.sanitize` runs its phone patterns before it folds anything,
 * for the same reason.
 *
 * `folded` exists for the one family that needs accents and case gone before it
 * can see anything: digits written as words.
 */
export type PatternScope = 'raw' | 'folded';

export interface PatternSpec {
  /** Recorded on the match; this is what lets "which rule fires wrongest?" be a query. */
  readonly id: string;
  readonly category: RedactionCategory;
  readonly scope: PatternScope;
  readonly pattern: RegExp;
}

/** `g` is required to walk every match; `.source` avoids sharing `lastIndex`. */
function global(pattern: RegExp, extraFlags = ''): RegExp {
  return new RegExp(pattern.source, `g${extraFlags}${pattern.flags}`);
}

/**
 * Digits spelled out, the cheapest way around a digit matcher.
 *
 * `une` is in because "zero six une deux" is how it gets typed, however wrong
 * that is grammatically.
 */
const SPELLED_DIGITS = [
  'zero',
  'un',
  'une',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
];

/**
 * Six or more consecutive number-ish tokens, where a token is a spelled digit
 * or a short group of figures.
 *
 * SIX, not three, and that threshold is the whole design. Everyday messages on
 * a job platform are full of small numbers — "6 ans d'experience", "2 enfants",
 * "15000 FCFA", "4 heures par jour" — and a filter that trips on those breaks
 * real conversations between people trying to work. Six consecutive is long
 * enough that no ordinary sentence reaches it and short enough to catch a
 * nine-digit number read aloud.
 *
 * Known and accepted: a bare run of six small figures ("100 200 300 400 500
 * 600") matches. It is rare enough in prose, and this category is separable
 * from the others precisely so it can be switched off on its own if the reports
 * say otherwise.
 */
const FIGURE_GROUP = String.raw`\d{1,3}`;
const NUMBER_TOKEN = `(?:${SPELLED_DIGITS.join('|')}|${FIGURE_GROUP})`;
const SPELLED_RUN = new RegExp(
  String.raw`\b${NUMBER_TOKEN}(?:\s+${NUMBER_TOKEN}){5,}\b`,
  'g',
);

/**
 * Links and messaging handles.
 *
 * A link is a contact channel: "mon profil facebook.com/x" hands over a way to
 * talk off-platform just as surely as a phone number does.
 *
 * The bare `@handle` form is last because it is the loosest. It overlaps with
 * emails by design — an email matches first and the two spans merge, so the
 * overlap costs nothing.
 */
const URL_PATTERN = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const MESSENGER_LINK = /\b(?:t\.me|wa\.me|m\.me|join\.skype\.com)\/\S+/gi;
const HANDLE_PATTERN = /@[a-z0-9._]{3,}/gi;

/**
 * The patterns that always run.
 *
 * ORDER IS PRIORITY, MOST SPECIFIC FIRST. When two spans overlap they merge
 * into one and the earlier entry names it, so the order decides what a mixed
 * fragment is reported AS — which is what the sender reads and what the
 * false-positive statistics are grouped by.
 *
 * Structured shapes lead, because they carry their own proof: an email needs an
 * `@` and a TLD, a messenger link needs a known host and a path. Digit runs come
 * after them, since figures appear INSIDE those shapes — `wa.me/242061234567`
 * satisfies `phone_bare` too, and calling that a phone number rather than a
 * WhatsApp link loses the useful half of the finding. The bare `@handle` is
 * last, being the loosest thing here.
 */
export const BASE_PATTERNS: readonly PatternSpec[] = [
  {
    id: 'email',
    category: 'EMAIL',
    scope: 'raw',
    pattern: global(EMAIL_PATTERN, 'i'),
  },
  {
    id: 'messenger_link',
    category: 'MESSAGING_HANDLE',
    scope: 'raw',
    pattern: MESSENGER_LINK,
  },
  { id: 'url', category: 'URL', scope: 'raw', pattern: URL_PATTERN },
  ...PHONE_PATTERNS.map(
    ([id, pattern]): PatternSpec => ({
      id,
      category: 'PHONE',
      scope: 'raw',
      pattern: global(pattern),
    }),
  ),
  {
    id: 'handle',
    category: 'MESSAGING_HANDLE',
    scope: 'raw',
    pattern: HANDLE_PATTERN,
  },
  {
    id: 'spelled_digits',
    category: 'OBFUSCATED_DIGITS',
    scope: 'folded',
    pattern: SPELLED_RUN,
  },
];

/**
 * Local operator prefixes, which live in configuration rather than here.
 *
 * Congolese prefixes appear nowhere in this repo and I have no authoritative
 * source for them, so hard-coding a guess would be worse than leaving the hook.
 * Configuration is also what lets the list widen the day somebody reports a way
 * around it, without a deploy.
 *
 * Each entry is a literal prefix ("06", "05"); anything that is not figures is
 * dropped rather than trusted, because this string arrives from the admin UI
 * and a stray character would otherwise become live regex.
 */
export function operatorPrefixPattern(
  prefixes: readonly string[],
): PatternSpec | null {
  const clean = [...new Set(prefixes.map((p) => p.trim()))].filter((p) =>
    /^\d{1,4}$/.test(p),
  );
  if (clean.length === 0) return null;

  return {
    id: 'operator_prefix',
    category: 'PHONE',
    scope: 'raw',
    pattern: new RegExp(
      String.raw`\b(?:${clean.join('|')})[\s.-]?(?:\d[\s.-]?){5,}\d\b`,
      'g',
    ),
  };
}
