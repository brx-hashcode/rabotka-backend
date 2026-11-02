import { sniffFileType } from '../../../common/utils/file-signature.util';

export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type CvFileType =
  | 'application/pdf'
  | typeof DOCX_MIME
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp';

export const MIN_TEXT_CHARS = 200;

const MAX_TEXT_CHARS = 15_000;


export function cvFileType(
  buffer: Buffer,
  declared: string,
): CvFileType | null {
  const sniffed = sniffFileType(buffer);
  if (sniffed) return sniffed;
  const isZip =
    buffer.length > 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04;
  return isZip && declared === DOCX_MIME ? DOCX_MIME : null;
}

export const CV_EXTENSION: Record<CvFileType, string> = {
  'application/pdf': 'pdf',
  [DOCX_MIME]: 'docx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};


export async function extractCvText(
  buffer: Buffer,
  type: CvFileType,
): Promise<string> {
  try {
    let raw = '';
    if (type === 'application/pdf') {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      raw = text;
    } else if (type === DOCX_MIME) {
      const mammoth = await import('mammoth');
      raw = (await mammoth.extractRawText({ buffer })).value;
    }
    return foldWhitespace(raw).slice(0, MAX_TEXT_CHARS);
  } catch {
    return '';
  }
}

export function foldWhitespace(text: string): string {
  return text
    .replace(/[ \t\f\v\r\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
