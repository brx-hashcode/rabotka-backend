import { Logger } from '@nestjs/common';
import { S3StorageProvider } from '../s3-storage.provider';
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

function makeConfigService(values: Record<string, string>) {
  return {
    get: (key: string, def?: string) => values[key] ?? def,
  } as any;
}

describe('S3StorageProvider', () => {
  const baseConfig = {
    AWS_REGION: 'us-east-1',
    AWS_S3_BUCKET: 'test-bucket',
    AWS_ACCESS_KEY_ID: 'key',
    AWS_SECRET_ACCESS_KEY: 'secret',
  };

  afterEach(() => jest.clearAllMocks());

  it('throws when AWS_S3_BUCKET is missing', () => {
    const config = makeConfigService({ AWS_REGION: 'us-east-1' });
    expect(() => new S3StorageProvider(config)).toThrow(
      'AWS_S3_BUCKET environment variable is required',
    );
  });

  it('creates with endpoint (path style)', () => {
    const config = makeConfigService({
      ...baseConfig,
      AWS_ENDPOINT_URL: 'http://localhost:9000',
    });
    expect(() => new S3StorageProvider(config)).not.toThrow();
  });

  it('creates without credentials', () => {
    const config = makeConfigService({ AWS_S3_BUCKET: 'bucket' });
    expect(() => new S3StorageProvider(config)).not.toThrow();
  });

  describe('upload', () => {
    it('uploads file and returns result', async () => {
      mockSend.mockResolvedValue({});
      mockGetSignedUrl.mockResolvedValue('https://signed-url');
      const provider = new S3StorageProvider(makeConfigService(baseConfig));
      const file = Buffer.from('data');
      const result = await provider.upload(file, 'file.txt');
      expect(result.key).toBe('file.txt');
      expect(result.url).toBe('https://signed-url');
      expect(result.provider).toBe(StorageProvider.S3);
      expect(result.size).toBe(4);
    });

    it('uploads with folder prefix', async () => {
      mockSend.mockResolvedValue({});
      mockGetSignedUrl.mockResolvedValue('https://signed-url');
      const provider = new S3StorageProvider(makeConfigService(baseConfig));
      const result = await provider.upload(Buffer.from('x'), 'img.png', {
        folder: 'uploads',
      });
      expect(result.key).toBe('uploads/img.png');
    });

    it('uses endpoint URL for getUrl when AWS_ENDPOINT_URL set', async () => {
      mockSend.mockResolvedValue({});
      const config = makeConfigService({
        ...baseConfig,
        AWS_ENDPOINT_URL: 'http://minio:9000',
      });
      const provider = new S3StorageProvider(config);
      const result = await provider.upload(Buffer.from('x'), 'file.txt');
      expect(result.url).toBe('http://minio:9000/test-bucket/file.txt');
    });

    it('throws on upload failure', async () => {
      mockSend.mockRejectedValue(new Error('network error'));
      const provider = new S3StorageProvider(makeConfigService(baseConfig));
      await expect(provider.upload(Buffer.from('x'), 'f.txt')).rejects.toThrow(
        'S3 upload failed: network error',
      );
    });

    it('uses custom bucket from options', async () => {
      mockSend.mockResolvedValue({});
      mockGetSignedUrl.mockResolvedValue('https://signed-url');
      const provider = new S3StorageProvider(makeConfigService(baseConfig));
      const result = await provider.upload(Buffer.from('x'), 'f.txt', {
        bucket: 'custom-bucket',
      });
      expect(result.bucket).toBe('custom-bucket');
    });
  });

  describe('delete', () => {
    it('deletes file successfully', async () => {
      mockSend.mockResolvedValue({});
      const provider = new S3StorageProvider(makeConfigService(baseConfig));
      await expect(provider.delete('file.txt')).resolves.toBeUndefined();
    });

    it('throws on delete failure', async () => {
      mockSend.mockRejectedValue(new Error('not found'));
      const provider = new S3StorageProvider(makeConfigService(baseConfig));
      await expect(provider.delete('file.txt')).rejects.toThrow(
        'S3 delete failed: not found',
      );
    });
  });

  describe('exists', () => {
    it('returns true when file exists', async () => {
      mockSend.mockResolvedValue({});
      const provider = new S3StorageProvider(makeConfigService(baseConfig));
      expect(await provider.exists('file.txt')).toBe(true);
    });

    it('returns false on NotFound error', async () => {
      const err: any = new Error('not found');
      err.name = 'NotFound';
      mockSend.mockRejectedValue(err);
      const provider = new S3StorageProvider(makeConfigService(baseConfig));
      expect(await provider.exists('file.txt')).toBe(false);
    });

    it('returns false on 404 metadata', async () => {
      const err: any = new Error('not found');
      err.$metadata = { httpStatusCode: 404 };
      mockSend.mockRejectedValue(err);
      const provider = new S3StorageProvider(makeConfigService(baseConfig));
      expect(await provider.exists('file.txt')).toBe(false);
    });

    it('throws on non-404 errors', async () => {
      mockSend.mockRejectedValue(new Error('internal error'));
      const provider = new S3StorageProvider(makeConfigService(baseConfig));
      await expect(provider.exists('file.txt')).rejects.toThrow(
        'S3 exists check failed: internal error',
      );
    });
  });
});
