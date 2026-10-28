/** What a CV attachment may be, by its name: the types « Analyse de CV » reads. */
const CV_EXTENSIONS = new Set(['pdf', 'docx', 'jpg', 'jpeg', 'png', 'webp']);

/** At most this many attachments in one analysis come from mails. */
export const MAX_MAIL_ATTACHMENTS = 5;

/** Mails older than this are not listed. */
export const MAIL_WINDOW_DAYS = 120;

export function cvKind(name: string): 'pdf' | 'word' | 'photo' | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (!CV_EXTENSIONS.has(ext)) return null;
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'word';
  return 'photo';
}

/**
 * Whether an attachment can be a CV. Inline pictures (signatures, logos) are
 * left out: they are small, or the mail says they are inline.
 */
export function isCvAttachment(a: {
  name: string;
  size: number;
  inline?: boolean;
}): boolean {
  if (!a.name || cvKind(a.name) === null) return false;
  if (cvKind(a.name) === 'photo' && (a.inline || a.size < 30_000)) return false;
  return a.size > 0;
}

/** A sender as « Name », without the address: the CV carries the contacts. */
export function senderName(from: string | undefined | null): string {
  if (!from) return '';
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(from);
  const name = (m ? m[1] : from).trim();
  if (name && !name.includes('@')) return name;
  // Only an address: its local part, which is all the list shows.
  const address = (m ? from.slice(from.indexOf('<') + 1) : from).trim();
  return address.split('@')[0] ?? '';
}
