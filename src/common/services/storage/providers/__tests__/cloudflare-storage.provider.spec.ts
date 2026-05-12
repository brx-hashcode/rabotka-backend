import { Logger } from '@nestjs/common';
import { CloudflareStorageProvider } from '../cloudflare-storage.provider';
import { StorageProvider } from '@prisma/client';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((args) => args),
  DeleteObjectCommand: jest.fn().mockImplementation((args) => args),
  HeadObjectCommand: jest.fn().mockImplementation((args) => args),
  GetObjectCommand: jest.fn().mockImplementation((args) => args),
}));

const mockGetSignedUrl = jest.fn();
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: any[]) => mockGetSignedUrl(...args),
}));

function makeConfig(values: Record<string, string>) {
  return { get: (key: string, def = '') => values[key] ?? def } as any;
}

const baseConfig = {
  CLOUDFLARE_ACCOUNT_ID: 'account123',
  CLOUDFLARE_BUCKET_NAME: 'my-bucket',
  CLOUDFLARE_ACCESS_KEY_ID: 'access-key',
  CLOUDFLARE_SECRET_ACCESS_KEY: 'secret-key',
  CLOUDFLARE_PUBLIC_BASE_URL: 'https://cdn.example.com',
};

describe('CloudflareStorageProvider', () => {
  afterEach(() => jest.clearAllMocks());

  it('throws when CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_BUCKET_NAME missing', () => {
    expect(() => new CloudflareStorageProvider(makeConfig({}))).toThrow(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_BUCKET_NAME environment variables are required',
    );
  });

  it('throws when access keys are missing', () => {
    expect(
      () =>
        new CloudflareStorageProvider(
          makeConfig({
            CLOUDFLARE_ACCOUNT_ID: 'acc',
            CLOUDFLARE_BUCKET_NAME: 'bucket',
          }),
        ),
    ).toThrow(
      'CLOUDFLARE_ACCESS_KEY_ID and CLOUDFLARE_SECRET_ACCESS_KEY environment variables are required',
    );
  });

  it('creates successfully with valid config', () => {
    expect(
      () => new CloudflareStorageProvider(makeConfig(baseConfig)),
    ).not.toThrow();
  });

  describe('upload', () => {
    it('uploads file and returns result', async () => {
      mockSend.mockResolvedValue({});
      mockGetSignedUrl.mockResolvedValue('https://signed-url');
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      const result = await provider.upload(Buffer.from('data'), 'file.txt');
      expect(result.key).toBe('file.txt');
      expect(result.provider).toBe(StorageProvider.CLOUDFLARE);
      expect(result.size).toBe(4);
    });

    it('uploads with folder', async () => {
      mockSend.mockResolvedValue({});
      mockGetSignedUrl.mockResolvedValue('https://url');
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      const result = await provider.upload(Buffer.from('x'), 'img.png', {
        folder: 'imgs',
      });
      expect(result.key).toBe('imgs/img.png');
    });

    it('throws on failure', async () => {
      mockSend.mockRejectedValue(new Error('upload error'));
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      await expect(provider.upload(Buffer.from('x'), 'f.txt')).rejects.toThrow(
        'Cloudflare R2 upload failed: upload error',
      );
    });
  });

  describe('delete', () => {
    it('deletes successfully', async () => {
      mockSend.mockResolvedValue({});
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      await expect(provider.delete('file.txt')).resolves.toBeUndefined();
    });

    it('throws on failure', async () => {
      mockSend.mockRejectedValue(new Error('delete error'));
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      await expect(provider.delete('file.txt')).rejects.toThrow(
        'Cloudflare R2 delete failed: delete error',
      );
    });
  });

  describe('getUrl', () => {
    it('returns signed URL', async () => {
      mockGetSignedUrl.mockResolvedValue('https://r2-signed-url');
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      expect(await provider.getUrl('file.txt')).toBe('https://r2-signed-url');
    });

    it('throws on failure', async () => {
      mockGetSignedUrl.mockRejectedValue(new Error('url error'));
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      await expect(provider.getUrl('file.txt')).rejects.toThrow(
        'Cloudflare R2 getUrl failed: url error',
      );
    });
  });

  describe('exists', () => {
    it('returns true when file exists', async () => {
      mockSend.mockResolvedValue({});
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      expect(await provider.exists('file.txt')).toBe(true);
    });

    it('returns false on NotFound', async () => {
      const err: any = new Error('not found');
      err.name = 'NotFound';
      mockSend.mockRejectedValue(err);
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      expect(await provider.exists('file.txt')).toBe(false);
    });

    it('returns false on 404 metadata', async () => {
      const err: any = new Error('not found');
      err.$metadata = { httpStatusCode: 404 };
      mockSend.mockRejectedValue(err);
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      expect(await provider.exists('file.txt')).toBe(false);
    });

    it('throws on non-404 errors', async () => {
      mockSend.mockRejectedValue(new Error('server error'));
      const provider = new CloudflareStorageProvider(makeConfig(baseConfig));
      await expect(provider.exists('file.txt')).rejects.toThrow(
        'Cloudflare R2 exists check failed: server error',
      );
    });
  });
});
