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


export function mediaKey(
  url: string | null | undefined,
  placeholderKey: string,
): string {
  if (url?.startsWith(`${WHATSAPP_MEDIA_BASE}/`)) {
    return url.slice(WHATSAPP_MEDIA_BASE.length + 1);
  }
  return placeholderKey;
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
    2: 'HX4b4efe03a3d7946ba1ea73a727bcac8c',
    3: 'HXd0b81686d2bf4dfa30112dffe75492b0',
    4: 'HXd361722d87179fb7a3b7103543d52e11',
    5: 'HXc14d753679bb10bcd3bcc87c21ede123',
  },
  jobs: {
    2: 'HX8d2bb43f677a9ff8a938c2891cfd304b',
    3: 'HXb5bd6825df309442d519fa3f04cf9add',
    4: 'HX5a77fba1f5c99443005b2d57f37342f5',
    5: 'HX9363237405e438383ddaad39f38ab937',
  },
};

export type CarouselCard = {
  title: string;
  image: string;
  body: string;
};


export const CARD_TITLE_MAX = 40;
export const CARD_BODY_MAX = 80;

export function truncateCardTitle(text: string): string {
  const t = text.trim();
  return t.length > CARD_TITLE_MAX ? `${t.slice(0, CARD_TITLE_MAX - 1)}…` : t;
}

export function truncateCardBody(text: string): string {
  const t = text.trim();
  return t.length > CARD_BODY_MAX ? `${t.slice(0, CARD_BODY_MAX - 1)}…` : t;
}


export function composeCardBody(
  fields: { label: string; value: string }[],
): string {
  const SEP = ' • ';
  let result = '';
  for (const { label, value } of fields) {
    const piece = `${label} : ${value.trim()}`;
    const candidate = result ? `${result}${SEP}${piece}` : piece;
    if (candidate.length <= CARD_BODY_MAX) {
      result = candidate;
      continue;
    }
    const prefix = result ? `${result}${SEP}${label} : ` : `${label} : `;
    const remaining = CARD_BODY_MAX - prefix.length;
    if (remaining >= 4) {
      result = `${prefix}${value.trim().slice(0, remaining - 1)}…`;
    }
    break;
  }
  return result;
}


export function carouselVariables(
  cards: CarouselCard[],
): Record<string, string> {
  const vars: Record<string, string> = {};
  cards.forEach((card, k) => {
    vars[String(3 * k + 1)] = truncateCardTitle(card.title);
    vars[String(3 * k + 2)] = card.image;
    vars[String(3 * k + 3)] = truncateCardBody(card.body);
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
  return `[TPL:${contentSid}]${JSON.stringify(carouselVariables(cards))}`;
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
