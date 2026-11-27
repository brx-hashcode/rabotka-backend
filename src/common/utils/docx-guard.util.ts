import { inflateRawSync } from 'node:zlib';

/**
 * Bounds on what a Word file (.docx, a zip) may expand to before a parser
 * such as mammoth reads it. mammoth builds the whole XML in memory, at
 * roughly 25 times its size, so a few kilobytes of zip that inflate to tens
 * of megabytes of XML are enough to exhaust the API's heap.
 *
 * A real CV's `word/document.xml` is well under 1 MB; images sit apart.
 */
export const DOCX_LIMITS = {
  maxEntries: 2_000,
  /** One XML part (`.xml`, `.rels`), inflated. */
  maxXmlPartBytes: 4 * 1024 * 1024,
  /** Every XML part together, inflated. */
  maxXmlTotalBytes: 8 * 1024 * 1024,
  /** Every entry together (images included), inflated. */
  maxTotalBytes: 48 * 1024 * 1024,
} as const;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * Whether a zip stays within {@link DOCX_LIMITS} once inflated. Sizes come
 * from actually inflating each entry under a hard output cap, never from
 * the sizes the zip declares (those can lie). The entry bytes measured here
 * are the ones a parser inflates later, so the bound holds for it too.
 *
 * Anything this reader does not handle (zip64, encryption, an unknown
 * compression method, a malformed directory) counts as unsafe: a CV never
 * needs it.
 */
export function isSafeDocx(
  buffer: Buffer,
  limits: typeof DOCX_LIMITS = DOCX_LIMITS,
): boolean {
  try {
    const end = findEndOfDirectory(buffer);
    if (end < 0) return false;
    const entries = buffer.readUInt16LE(end + 10);
    const dirSize = buffer.readUInt32LE(end + 12);
    const dirStart = buffer.readUInt32LE(end + 16);
    if (entries === 0xffff || dirStart === 0xffffffff) return false; // zip64
    if (entries > limits.maxEntries) return false;
    if (dirStart + dirSize > end) return false;

    let at = dirStart;
    let total = 0;
    let xmlTotal = 0;
    for (let i = 0; i < entries; i++) {
      if (buffer.readUInt32LE(at) !== CENTRAL) return false;
      const flags = buffer.readUInt16LE(at + 8);
      const method = buffer.readUInt16LE(at + 10);
      const compressed = buffer.readUInt32LE(at + 20);
      const nameLength = buffer.readUInt16LE(at + 28);
      const extraLength = buffer.readUInt16LE(at + 30);
      const commentLength = buffer.readUInt16LE(at + 32);
      const localAt = buffer.readUInt32LE(at + 42);
      const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;

      if (flags & 0x1) return false; // encrypted
      if (compressed === 0xffffffff || localAt === 0xffffffff) return false;
      if (buffer.readUInt32LE(localAt) !== LOCAL) return false;
      const dataAt =
        localAt +
        30 +
        buffer.readUInt16LE(localAt + 26) +
        buffer.readUInt16LE(localAt + 28);
      if (dataAt + compressed > buffer.length) return false;

      const isXml = /\.(xml|rels)$/i.test(name);
      const cap = Math.min(
        isXml ? limits.maxXmlPartBytes : limits.maxTotalBytes,
        limits.maxTotalBytes - total,
        isXml ? limits.maxXmlTotalBytes - xmlTotal : Infinity,
      );
      const size = inflatedSize(
        buffer.subarray(dataAt, dataAt + compressed),
        method,
        cap,
      );
      if (size < 0) return false;
      total += size;
      if (isXml) xmlTotal += size;
    }
    return true;
  } catch {
    return false;
  }
}

/** Inflated size of one entry, or -1 when it exceeds `cap` or can't be read. */
function inflatedSize(data: Buffer, method: number, cap: number): number {
  if (cap < 0) return -1;
  if (method === 0) return data.length <= cap ? data.length : -1;
  if (method !== 8) return -1;
  try {
    // zlib throws once the output would pass the cap.
    const size = inflateRawSync(data, {
      maxOutputLength: Math.max(cap, 1),
    }).length;
    return size <= cap ? size : -1;
  } catch {
    return -1;
  }
}

/** Offset of the end-of-central-directory record, searched from the end. */
function findEndOfDirectory(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}
