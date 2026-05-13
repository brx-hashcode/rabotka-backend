import { Logger } from '@nestjs/common';
import { StorageProviderFactory } from '../storage-provider.factory';
import { S3StorageProvider } from '../providers/s3-storage.provider';
import { CloudinaryStorageProvider } from '../providers/cloudinary-storage.provider';
import { VercelBlobStorageProvider } from '../providers/vercel-blob-storage.provider';
import { CloudflareStorageProvider } from '../providers/cloudflare-storage.provider';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

// Mock all providers so their constructors don't need real credentials
jest.mock('../providers/s3-storage.provider');
jest.mock('../providers/cloudinary-storage.provider');
jest.mock('../providers/vercel-blob-storage.provider');
jest.mock('../providers/cloudflare-storage.provider');

function makeConfig(driver: string) {
  return { get: jest.fn().mockReturnValue(driver) };
}

describe('StorageProviderFactory', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates S3StorageProvider for DRIVER=S3', async () => {
    const factory = new StorageProviderFactory(makeConfig('S3') as any);
    await factory.create();
    expect(S3StorageProvider).toHaveBeenCalled();
  });

  it('creates CloudinaryStorageProvider for DRIVER=CLOUDINARY', async () => {
    const factory = new StorageProviderFactory(makeConfig('CLOUDINARY') as any);
    await factory.create();
    expect(CloudinaryStorageProvider).toHaveBeenCalled();
  });

  it('creates VercelBlobStorageProvider for DRIVER=VERCEL_BLOB', async () => {
    const factory = new StorageProviderFactory(
      makeConfig('VERCEL_BLOB') as any,
    );
    await factory.create();
    expect(VercelBlobStorageProvider).toHaveBeenCalled();
  });

  it('creates CloudflareStorageProvider for DRIVER=CLOUDFLARE', async () => {
    const factory = new StorageProviderFactory(makeConfig('CLOUDFLARE') as any);
    await factory.create();
    expect(CloudflareStorageProvider).toHaveBeenCalled();
  });

  it('falls back to S3 for unknown driver', async () => {
    const factory = new StorageProviderFactory(
      makeConfig('UNKNOWN_DRIVER') as any,
    );
    await factory.create();
    expect(S3StorageProvider).toHaveBeenCalled();
  });

  it('is case-insensitive (lowercase driver name)', async () => {
    const factory = new StorageProviderFactory(makeConfig('s3') as any);
    await factory.create();
    expect(S3StorageProvider).toHaveBeenCalled();
  });
});
