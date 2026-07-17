export const WHATSAPP_MEDIA_BASE = (
  process.env.CLOUDFLARE_PUBLIC_BASE_URL ??
  'https://pub-fd4c940e661d483b955abd6d7de0e17f.r2.dev'
).replace(/\/$/, '');

export const JOB_PLACEHOLDER_KEY = 'whatsapp/job-placeholder.png';
export const PROFILE_PLACEHOLDER_KEY = 'whatsapp/profile-placeholder.png';

/**
 * Full public URL of a profile's header image for a WhatsApp media message:
 * the worker's avatar when set, else the profile placeholder — so a profile
 * view always shows a picture instead of rendering with none.
 */
export function profileImageUrl(avatarUrl: string | null | undefined): string {
  return (
    avatarUrl?.trim() || `${WHATSAPP_MEDIA_BASE}/${PROFILE_PLACEHOLDER_KEY}`
  );
}


/**
 * Full public URL of a job card's header image. Jobs have no per-offer photo,
 * so every card uses the same placeholder.
 */
export function jobImageUrl(): string {
  return `${WHATSAPP_MEDIA_BASE}/${JOB_PLACEHOLDER_KEY}`;
}

export type CarouselEntity = 'profiles' | 'jobs';

// Meta requires at least 2 cards per WhatsApp carousel template (and each
// approved template is locked to its exact card count), so a single result
// is never sent as a carousel — callers fall back to plain text for count 1.
export type CardCount = 2 | 3 | 4 | 5;
export const MIN_CARDS: CardCount = 2;
export const MAX_CARDS: CardCount = 5;

export const CAROUSEL_TEMPLATES: Record<
  CarouselEntity,
  Record<CardCount, string>
> = {
  profiles: {
    2: 'HXd5081b4e58a999a71a79d04ec12886d7',
    3: 'HX5a006de098ad40a3c79a44d3f5d96572',
    4: 'HX1b8815af63d92f6b2fe5db39b8cfd58e',
    5: 'HXa7692e79775cb42143625f5b390e8041',
  },
  jobs: {
    2: 'HX97bbc0e84a73f3121c67e9e282b32739',
    3: 'HX73f1505c93d5f459edb89b2b8e843774',
    4: 'HXa7b2e188b13110c3352fd0803064cc7b',
    5: 'HX0edfe2c17dc69fc2a253694c2eefd9c7',
  },
};

export type CarouselCard = {
  title: string;
  image: string;
  body: string;
};


/**
 * Meta's hard limit per carousel card: title and body TOGETHER may not exceed
 * 160 characters. Exceeding it fails template approval with subCode 2388337
 * ("Carousel card at index N exceeds the limit of 160 characters") — note the
 * Twilio Content Builder shows 1024 for these fields, which is the Content API's
 * cross-channel limit and NOT what WhatsApp enforces.
 */
export const CARD_MAX = 160;

export const CARD_TITLE_MAX = 40;

/**
 * Static text baked into each card body in the approved template, immediately
 * before the single value variable (e.g. `Profil recommandé pour vous : {{3}}`).
 *
 * This prefix is load-bearing, not decoration: Meta rejects a card body that is
 * mostly variable with subCode 2388293 ("too many variables for its length"),
 * so `{{3}}` alone — or several variables inline — cannot be approved. Since it
 * must exist, it says why the card is here (these lists are ranked
 * recommendations) rather than repeating the per-field labels the value already
 * carries.
 *
 * MUST stay in sync with CARD_LABEL in create-carousel-templates.js, which
 * bakes these exact strings into the templates; the budget below is derived
 * from their length, so a drift here silently overruns the 160-char card cap.
 */
export const CARD_BODY_PREFIX: Record<CarouselEntity, string> = {
  profiles: 'Profil recommandé pour vous : ',
  jobs: 'Mission recommandée pour vous : ',
};

export function truncateCardTitle(text: string): string {
  const t = text.trim();
  return t.length > CARD_TITLE_MAX ? `${t.slice(0, CARD_TITLE_MAX - 1)}…` : t;
}

/**
 * How many characters of real data a card's value variable may carry: whatever
 * the 160-char card budget has left once the rendered title and the template's
 * static prefix are accounted for.
 */
export function cardBodyBudget(entity: CarouselEntity, title: string): number {
  return (
    CARD_MAX - truncateCardTitle(title).length - CARD_BODY_PREFIX[entity].length
  );
}

export function truncateCardBody(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Join `label : value` fields with • up to `max` characters, truncating the
 * field that overflows rather than dropping it silently.
 */
export function composeCardBody(
  fields: { label: string; value: string }[],
  max: number,
): string {
  const SEP = ' • ';
  let result = '';
  for (const { label, value } of fields) {
    const piece = `${label} : ${value.trim()}`;
    const candidate = result ? `${result}${SEP}${piece}` : piece;
    if (candidate.length <= max) {
      result = candidate;
      continue;
    }
    const prefix = result ? `${result}${SEP}${label} : ` : `${label} : `;
    const remaining = max - prefix.length;
    if (remaining >= 4) {
      result = `${prefix}${value.trim().slice(0, remaining - 1)}…`;
    }
    break;
  }
  return result;
}


/**
 * Positional variables for a carousel send: per card, title / image / body.
 * The body is clamped to the card's remaining budget as a last line of defence
 * — WhatsApp would otherwise cut a card that renders past 160 characters.
 */
export function carouselVariables(
  entity: CarouselEntity,
  cards: CarouselCard[],
): Record<string, string> {
  const vars: Record<string, string> = {};
  cards.forEach((card, k) => {
    vars[String(3 * k + 1)] = truncateCardTitle(card.title);
    vars[String(3 * k + 2)] = card.image;
    vars[String(3 * k + 3)] = truncateCardBody(
      card.body,
      cardBodyBudget(entity, card.title),
    );
  });
  return vars;
}


export function carouselReply(
  entity: CarouselEntity,
  cards: CarouselCard[],
): string | null {
  const count = cards.length;
  if (count < MIN_CARDS || count > MAX_CARDS) return null;
  const contentSid = CAROUSEL_TEMPLATES[entity][count as CardCount];
  return `[TPL:${contentSid}]${JSON.stringify(carouselVariables(entity, cards))}`;
}

/**
 * Encode a Content-template send as a bot reply string. The inbound pipeline
 * (parseReplyToJob in whatsapp-inbound.processor.ts) turns any reply starting
 * with `[TPL:<contentSid>]<jsonVars>` into a template outbound job — so a flow
 * can return a template (e.g. one with a URL button) in place of plain text.
 */
export function templateReply(
  contentSid: string,
  variables: Record<string, string> = {},
): string {
  return `[TPL:${contentSid}]${JSON.stringify(variables)}`;
}
