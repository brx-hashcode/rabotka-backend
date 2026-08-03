export const WHATSAPP_MEDIA_BASE = (
  process.env.CLOUDFLARE_PUBLIC_BASE_URL ??
  'https://pub-fd4c940e661d483b955abd6d7de0e17f.r2.dev'
).replace(/\/$/, '');

export const JOB_PLACEHOLDER_KEY = 'whatsapp/job-placeholder.png';
export const PROFILE_PLACEHOLDER_KEY = 'whatsapp/profile-placeholder.png';
export const COVER_KEY = 'whatsapp/cover-rabotka.jpg';

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

/**
 * Full public URL of the brand cover, used as the header image of the welcome
 * cards — the first thing a number sees from Rabotka, registered or not.
 */
export function coverImageUrl(): string {
  return `${WHATSAPP_MEDIA_BASE}/${COVER_KEY}`;
}

// Meta requires at least 2 cards per WhatsApp carousel template (and each
// approved template is locked to its exact card count), so a single result
// is never sent as a carousel — callers fall back to plain text for count 1.

/**
 * Make a free-text value safe to inject into a WhatsApp template variable.
 *
 * Values come from user input (a worker's description, a job's title/address),
 * and WhatsApp rejects the whole send with Twilio 63013 ("Channel policy
 * violation") when a variable contains a newline, a run of 4+ whitespace
 * characters, or control characters — carousel card bodies are single-line and
 * cannot carry any of these. Collapsing every whitespace run to one space and
 * stripping C0 control chars makes those triggers impossible. Emojis are left
 * intact: WhatsApp body text supports them.
 */
export function sanitizeTemplateValue(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]+/g, ' ') // newlines/tabs/control chars -> space
      .replace(/\s+/g, ' ') // collapse any remaining whitespace run
      .trim()
  );
}

// A carousel needs ≥2 cards, so a single recommendation used to fall back to a
// plain-text list. Instead send one twilio/card (media + title + "Sélectionner"
// quick-reply button, id "1"). A single-button card needs no template approval
// and sends in-session; the "1" payload is parsed by the recommendation flows
// as selecting the first (only) item. Same template for profiles and jobs.
//
// WhatsApp renders a card's media + title + button but NOT its body, so the
// name and the details are packed together into the TITLE (bold name, then the
// composed details line). {{1}} = media, {{2}} = title.

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
