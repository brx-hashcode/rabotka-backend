import type { WhatsAppTemplateName } from './whatsapp-templates';

// The bucket that actually serves the cover. The previous default,
// pub-fd4c940e661d483b955abd6d7de0e17f, returns 404 for whatsapp/cover-rabotka.jpg
// — the approved Twilio cards point here instead. Only the free-form fallback in
// welcome.messages.ts reads this (the cards bake the image in), and that branch
// is unreachable while contentSid is set, which is why a dead image URL went
// unnoticed.
// Deliberately NOT CLOUDFLARE_PUBLIC_BASE_URL. That is the public base for user
// file storage — avatars, documents, portfolios — and it points at the bucket
// those files live in. The WhatsApp cover lives in a DIFFERENT bucket, the one
// the approved Twilio cards reference, so reading the storage base here made the
// cover 404 on any environment where storage was configured:
// `131053 Downloading media from weblink failed with http code 404`.
//
// Repointing the storage variable would have fixed the cover and broken every
// existing file URL in the app, so the two are separated instead.
//
// `||` rather than `??`: the deploy writes env values through
// `jq -r '… // ""'`, so an absent key arrives as an EMPTY STRING and `??` would
// not fall back. Trimmed because docker compose `env_file` does not.
export const WHATSAPP_MEDIA_BASE = (
  process.env.WHATSAPP_MEDIA_BASE_URL?.trim() ||
  'https://pub-1c3331ee6be84a71b4be0db2b3734ac7.r2.dev'
).replace(/\/$/, '');

export const COVER_KEY = 'whatsapp/cover-rabotka.jpg';

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
 * Encode a template send as a bot reply string. The inbound pipeline
 * (parseReplyToJob in whatsapp-inbound.processor.ts) turns any reply starting
 * with `[TPL:<templateKey>]<jsonVars>` into a template outbound job — so a flow
 * can return a template (e.g. one with a URL button) in place of plain text.
 *
 * Carries the logical key rather than a Twilio content SID. Both ends live in
 * the same request — a flow returns the string and the inbound processor parses
 * it immediately — so unlike the queue payload there is no old encoding still
 * in flight to stay compatible with.
 */
export function templateReply(
  templateKey: WhatsAppTemplateName,
  variables: Record<string, string> = {},
): string {
  return `[TPL:${templateKey}]${JSON.stringify(variables)}`;
}

/** A bot reply sent as a free-form CTA message, decoded by `parseReplyToJob`. */
export interface CtaReply {
  body: string;
  buttonText: string;
  /** Path under FRONTEND_URL. The outbound worker mints the one-tap login link. */
  path: string;
  imageUrl?: string;
  /** The template to fall back to when the 24h window turns out to be shut. */
  fallbackTemplate: WhatsAppTemplateName;
  fallbackVariables?: Record<string, string>;
}

/**
 * Encode a free-form CTA send as a bot reply string, `[CTA:]<json>`.
 *
 * The cheap twin of `templateReply`. A reply is by definition inside the 24h
 * service window, where a free-form message costs nothing while an approved
 * MARKETING template is billed all the same — and a `cta_url` message keeps the
 * tappable button that made those replies templates in the first place.
 *
 * Carries its own fallback template rather than leaving the outbound worker to
 * guess one: the window can close between the reply being built and the job
 * being drained, and the reply is the only place that knows which approved
 * template says the same thing.
 *
 * `path` rather than a URL, so the login code is minted at send time by the
 * same machinery that rewrites template button URLs. A URL baked in here would
 * be a dead link by the time it arrives.
 */
export function ctaReply(reply: CtaReply): string {
  return `[CTA:]${JSON.stringify(reply)}`;
}
