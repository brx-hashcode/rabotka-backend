import type { Response } from 'express';

/**
 * Streams a private file (KYC, business papers) to its one allowed reader:
 * shown inline, never cached, never sniffed into another type.
 */
export function sendPrivateFile(
  res: Response,
  file: {
    body: NodeJS.ReadableStream;
    contentType?: string;
    contentLength?: number;
    filename: string;
  },
): void {
  res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
  if (file.contentLength !== undefined) {
    res.setHeader('Content-Length', String(file.contentLength));
  }
  // `inline` so an <img> or a PDF viewer renders it rather than downloading
  // it; the filename is only there for when someone does save a copy.
  res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  // The bytes are someone's papers; nothing should be sniffing them into a
  // different content type and rendering them as a document.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  file.body.pipe(res);
}
