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
 * Number words, the cheapest way around a digit matcher.
 *
 * The first version knew only zero to nine, and was bypassed in its first real
 * test: "zero six huit cent cinq" went through CLEAN. Nobody here dictates a
 * phone number digit by digit — they say it in PAIRS, the French way: « zéro
 * six, quatre-vingt-dix-neuf, dix-sept, soixante-huit ». Dix, vingt, soixante
 * and cent were simply not in the list.
 *
 * Folded text, so accents and hyphens are already gone: « quatre-vingt-dix »
 * arrives as three tokens, « zéro » as "zero".
 *
 * `une` is in because "zero six une deux" is how it gets typed, however wrong
 * that is grammatically.
 */
const NUMBER_WORDS = [
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
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
  'vingt',
  'vingts',
  'trente',
  'quarante',
  'cinquante',
  'soixante',
  'cent',
  'cents',
  'mille',
];

const FIGURE_GROUP = String.raw`\d{1,3}`;
const NUMBER_TOKEN = `(?:${NUMBER_WORDS.join('|')}|${FIGURE_GROUP})`;

/**
 * Between two number tokens: whitespace, optionally with « et » in it.
 *
 * « soixante et onze » is one number. But « et » is ALSO in nearly every
 * sentence, so it is allowed only as glue between two numbers and never counts
 * as a token itself — otherwise it could start a run, end one, or pad a short
 * one past the threshold.
 */
const NUMBER_GAP = String.raw`\s+(?:et\s+)?`;

/**
 * Six or more consecutive number tokens.
 *
 * SIX, and that threshold is what protects prices written out in full:
 * « quatre vingt dix neuf mille francs » is five tokens and must stay legible
 * in a negotiation about a job. Everyday small numbers — "6 ans d'experience",
 * "2 enfants", "15000 FCFA" — never come close.
 *
 * Known and accepted: a bare run of six small figures ("100 200 300 400 500
 * 600") matches. Rare in prose, and this category can be switched off alone.
 */
const SPELLED_RUN = new RegExp(
  String.raw`\b${NUMBER_TOKEN}(?:${NUMBER_GAP}${NUMBER_TOKEN}){5,}\b`,
  'g',
);

/**
 * « zéro » followed by three or more number tokens.
 *
 * The sharper rule, and the one that caught the real bypass. Every Congolese
 * mobile number starts with 0 — 04, 05, 06 — and a price, a date or a
 * quantity NEVER starts with « zéro ». So a run that opens on it is a phone
 * number at four tokens, without lowering the six-token threshold that keeps
 * written-out prices readable.
 *
 * Still a per-message rule: a number split across two messages — "zero six
 * huit" then "cent cinq quarante" — gets past both. That is what the semantic
 * pass is for, and it is not built yet.
 */
const ZERO_LED_RUN = new RegExp(
  String.raw`\bzero(?:${NUMBER_GAP}${NUMBER_TOKEN}){3,}\b`,
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
/**
 * A link cannot END on punctuation.
 *
 * `\S+` is greedy and swallows whatever follows — "ecris sur wa.me/242061234567,
 * on s'arrange" matched the comma too, so the recipient read
 * "sur [contact masqué] on s'arrange" with the sentence's punctuation gone.
 * The hole should be the link's shape, not a character more.
 */
const LINK_TAIL = String.raw`\S*[^\s.,;:!?)\]"']`;

const URL_PATTERN = new RegExp(
  String.raw`\bhttps?:\/\/${LINK_TAIL}|\bwww\.${LINK_TAIL}`,
  'gi',
);
const MESSENGER_LINK = new RegExp(
  String.raw`\b(?:t\.me|wa\.me|m\.me|join\.skype\.com)\/${LINK_TAIL}`,
  'gi',
);
const HANDLE_PATTERN = /@[a-z0-9._]{2,}[a-z0-9]/gi;

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
    id: 'spelled_zero_lead',
    category: 'OBFUSCATED_DIGITS',
    scope: 'folded',
    pattern: ZERO_LED_RUN,
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
