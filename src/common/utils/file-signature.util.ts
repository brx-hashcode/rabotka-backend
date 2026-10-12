/**
 * The type a file's first bytes say it is — never the type the client
 * declared, which is a header anyone can set. Covers what uploads accept:
 * JPEG, PNG, WEBP and PDF. Null for anything else.
 */
export type SniffedFileType =
  'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export function sniffFileType(
  buffer: Buffer | undefined | null,
): SniffedFileType | null {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}
