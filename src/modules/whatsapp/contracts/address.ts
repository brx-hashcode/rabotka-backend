import type { E164 } from './messages.types';

/**
 * Coerce whatever we hold for a contact into the canonical `+242069917686`.
 *
 * Numbers reach us from several places that do not agree on formatting: the
 * `profiles.phone` column, an admin typing into the back office, and the `From`
 * field of an inbound webhook (which arrives `whatsapp:`-prefixed). Each
 * provider then wants its own variant, so everything funnels through here first
 * and the mappers format from a single known shape.
 *
 * Separators are stripped. The previous implementation did not do this, so a
 * number stored as `+242 06 99 17 686` was handed to Twilio verbatim as
 * `whatsapp:+242 06 99 17 686` and the send simply failed — this can only turn
 * a guaranteed failure into a working send.
 *
 * A number with no country code is NOT given one. Guessing `+242` would send
 * real messages to whoever owns that number in another country; leaving it
 * malformed makes the provider reject it, which is the safer failure.
 */
export function toE164(raw: string): E164 {
  let value = raw.trim();

  if (value.toLowerCase().startsWith('whatsapp:')) {
    value = value.slice('whatsapp:'.length).trim();
  }

  // Spaces, dots, parentheses and every dash a number gets typed with. Written
  // as escapes rather than literals: the non-breaking space and en/em dashes
  // that arrive when a number is pasted out of a contact card are invisible in
  // source and trip the no-irregular-whitespace rule.
  value = value.replace(/[\s\u00A0().\u002D\u2010-\u2015]/g, '');

  // `00` is the international prefix in CG dialling habits, and pasting from a
  // contact card produces it often enough to be worth handling.
  if (value.startsWith('00')) {
    return `+${value.slice(2)}`;
  }

  return value.startsWith('+') ? value : `+${value}`;
}

/** Digits only, no `+` — what the Meta Cloud API expects as `to`. */
export function toDigits(raw: string): string {
  return toE164(raw).replace(/^\+/, '');
}
