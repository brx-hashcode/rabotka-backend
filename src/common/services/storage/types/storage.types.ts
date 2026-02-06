import { StorageProvider } from '@prisma/client';

export enum StorageDriver {
  S3 = 'S3',
  LOCAL = 'LOCAL',
  CLOUDINARY = 'CLOUDINARY',
  VERCEL_BLOB = 'VERCEL_BLOB',
  CLOUDFLARE = 'CLOUDFLARE',
}

export type UploadOptions = {
  mimeType?: string;
  folder?: string;
  metadata?: Record<string, string>;
  access?: 'public' | 'private';
  bucket?: string;
};

export type UploadResult = {
  key: string;
  url: string;
  provider: StorageProvider;
  bucket?: string;
  size?: number;
};
