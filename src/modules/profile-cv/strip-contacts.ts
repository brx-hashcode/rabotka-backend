import { detectContacts } from '../profile-chat/moderation/detect';
import { redact } from '../profile-chat/moderation/redact';

/** Below `detectContacts`' own scan window, which silently ignores the rest. */
const CHUNK = 3_500;

/**
 * A CV's text without its phone numbers, e-mails and links: what a recruiter's
 * scoring may read before the contact is unlocked.
 *
 * In chunks cut on whitespace, because the detector only looks at the first
 * 4 000 characters of what it is given, and a CV runs to 15 000.
 */
export function stripContacts(text: string): string {
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    let cut = rest.length;
    if (cut > CHUNK) {
      const space = rest.lastIndexOf(' ', CHUNK);
      cut = space > CHUNK / 2 ? space + 1 : CHUNK;
    }
    const piece = rest.slice(0, cut);
    out.push(redact(piece, detectContacts(piece)));
    rest = rest.slice(cut);
  }
  return out.join('');
}
