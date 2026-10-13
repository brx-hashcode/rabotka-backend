import { StorageProvider } from '@prisma/client';

export enum StorageDriver {
  S3 = 'S3',
  LOCAL = 'LOCAL',
  CLOUDINARY = 'CLOUDINARY',
  VERCEL_BLOB = 'VERCEL_BLOB',
  CLOUDFLARE = 'CLOUDFLARE',
}

export type UrlAccess = 'public' | 'private';

/**
 * How long a signed URL stays valid. One hour.
 *
 * Named rather than repeated as `3600` in each provider, because it is a
 * product decision, not a magic number: an admin reviewing a KYC file gets a
 * link that dies within the hour, so a URL copied out of the network tab — or
 * left in a browser history — stops working on its own.
 *
 * Raising it weakens that. Lowering it breaks review sessions mid-way, and the
 * page gives no clear error when an image 403s.
 */
export const SIGNED_URL_TTL_SECONDS = 3600;

export type GetUrlOptions = {
  access?: UrlAccess;
  /**
   * Bucket to read from, when it is not the default one.
   *
   * `UploadOptions` has carried this for a while and `upload()` honours it, so
   * a file could be *written* to a second bucket and then never *read* back:
   * `getUrl` had no way to say where to look. That gap is what kept KYC
   * documents in the public bucket — the only bucket a signed URL could
   * address.
   */
  bucket?: string;
};

/**
 * Where to look for an object.
 *
 * Same reason `GetUrlOptions` grew a bucket: an existence check against the
 * default bucket answers a different question than the caller asked, and it
 * answers it wrongly in the direction that matters — "no such KYC document"
 * for a document that is sitting safely in the private bucket.
 */
export type ExistsOptions = {
  bucket?: string;
};

/** Which bucket to delete from, when it is not the default one (KYC files). */
export type DeleteOptions = {
  bucket?: string;
};

/** Where to read an object from, when it is not the default bucket. */
export type DownloadOptions = {
  bucket?: string;
};

/**
 * An object's bytes, streamed.
 *
 * KYC files are read this way rather than through a signed url so the url
 * never reaches the browser at all. A signed url handed to an admin's tab is a
 * bearer credential: it survives in history and in the network panel, it works
 * for anyone who copies it, and it goes stale while the tab sits open — which
 * is how an ID card became a broken image in the first place.
 *
 * `body` is a stream, not a Buffer, because these are photographs and a review
 * queue loads several at once; buffering each one whole would hold megabytes
 * per concurrent request for no reason.
 */
export type DownloadResult = {
  body: NodeJS.ReadableStream;
  contentType?: string;
  contentLength?: number;
};

export type UploadOptions = {
  mimeType?: string;
  folder?: string;
  metadata?: Record<string, string>;
  access?: UrlAccess;
  bucket?: string;
};

export type UploadResult = {
  key: string;
  url: string;
  provider: StorageProvider;
  bucket?: string;
  size?: number;
};
