/**
 * Strip invisible / directional characters often prefixed by WhatsApp or mobile
 * keyboards. Without this, "Menu" may not match CMD_MENU (e.g. LRM + "menu").
 */
export function stripChatFormattingChars(input: string): string {
  return input.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '');
}

/**
 * Turn a slash command into the plain word the bot already understands.
 *
 * `/` is the discoverable way to ask for the menu \u2014 people reach for it because
 * every other chat product they use has it \u2014 but nothing in the router knew
 * about it, so `/` and `/start` fell through to the "I didn't understand"
 * branch. This maps them onto the existing vocabulary instead of adding a
 * second parallel command system:
 *
 *   "/"       -> "menu"
 *   "/menu"   -> "menu"
 *   "/start"  -> "start"   (already in CMD_MENU)
 *   "/payer"  -> "payer"   (already in CMD_PAY)
 *
 * Applied ONCE at the conversation entry point, so every flow downstream sees
 * the plain word \u2014 including the mid-flow escape, which is exactly when someone
 * types it.
 *
 * Deliberately does NOT lowercase. This runs over every inbound message, and
 * the flows that capture free text (a cancellation reason, a rejection note)
 * would have the reader's own words flattened.
 *
 * A slash anywhere but the start is left alone: "24/7" and "https://\u2026" are
 * ordinary message content, not commands.
 */
export function expandSlashCommand(input: string): string {
  const trimmed = stripChatFormattingChars(input.trim());
  if (trimmed === '/') return 'menu';
  // One slash then a letter. Guards against "//", "/1" and a bare URL, none of
  // which are commands.
  if (/^\/[^\W\d_]/u.test(trimmed)) return trimmed.slice(1);
  return input;
}
