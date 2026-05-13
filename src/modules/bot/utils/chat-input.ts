/**
 * Strip invisible / directional characters often prefixed by WhatsApp or mobile
 * keyboards. Without this, "Menu" may not match CMD_MENU (e.g. LRM + "menu").
 */
export function stripChatFormattingChars(input: string): string {
  return input.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '');
}
