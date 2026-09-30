/**
 * What `POST /file/upload` accepts, and how each type is stored.
 *
 * The route took any file, stored it under the extension in its client-supplied
 * name, with the client-supplied content type, and `?access=public` put it in
 * the public bucket. That is an `.html` or `.svg` served from our storage host
 * under a permanent url — a page we host for whoever uploaded it.
 *
 * So the type is decided HERE, from the pair (extension, declared type), and
 * both the stored extension and the stored content type come from this table
 * rather than from the request. The list is what the admin actually uploads
 * through this route: ad images and partner logos, and platform documents
 * (.docx, .pdf, .md).
 *
 * No `svg`, for the reason `image-upload.ts` gives: it is a document that can
 * carry script, and these objects are served unauthenticated.
 */
type UploadType = {
  /** Extension the object is stored under. */
  extension: string;
  /** Content type the object is stored — and later served — with. */
  contentType: string;
  /** Declared types a browser may send for this extension. */
  declared: readonly string[];
};

// `.md` has no registered type a browser agrees on: Chrome sends nothing, which
// multer reports as octet-stream. It is stored as text/plain so that, whatever
// it contains, a browser shows it as text.
const MARKDOWN_DECLARED = [
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'application/octet-stream',
  '',
];

const UPLOAD_TYPES: Record<string, UploadType> = {
  jpg: {
    extension: 'jpg',
    contentType: 'image/jpeg',
    declared: ['image/jpeg'],
  },
  jpeg: {
    extension: 'jpg',
    contentType: 'image/jpeg',
    declared: ['image/jpeg'],
  },
  png: { extension: 'png', contentType: 'image/png', declared: ['image/png'] },
  webp: {
    extension: 'webp',
    contentType: 'image/webp',
    declared: ['image/webp'],
  },
  gif: { extension: 'gif', contentType: 'image/gif', declared: ['image/gif'] },
  pdf: {
    extension: 'pdf',
    contentType: 'application/pdf',
    declared: ['application/pdf'],
  },
  docx: {
    extension: 'docx',
    contentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    declared: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      // What some browsers send when the OS has no association for .docx.
      'application/octet-stream',
      'application/zip',
    ],
  },
  md: {
    extension: 'md',
    contentType: 'text/plain; charset=utf-8',
    declared: MARKDOWN_DECLARED,
  },
};

export const ACCEPTED_UPLOAD_EXTENSIONS = Object.keys(UPLOAD_TYPES);

/**
 * The stored extension and content type for an upload, or null when the file
 * is not one this route takes.
 */
export function resolveUploadType(
  originalName: string,
  declaredType: string,
): { extension: string; contentType: string; isImage: boolean } | null {
  const dot = originalName.lastIndexOf('.');
  if (dot === -1) return null;

  const type = UPLOAD_TYPES[originalName.slice(dot + 1).toLowerCase()];
  if (!type) return null;

  const declared = (declaredType ?? '').split(';')[0].trim().toLowerCase();
  if (!type.declared.includes(declared)) return null;

  return {
    extension: type.extension,
    contentType: type.contentType,
    isImage: type.contentType.startsWith('image/'),
  };
}
