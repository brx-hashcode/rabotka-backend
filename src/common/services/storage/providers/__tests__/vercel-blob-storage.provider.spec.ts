import { StorageProvider } from '@prisma/client';

const mockPut = jest.fn();
const mockDel = jest.fn();
const mockHead = jest.fn();

jest.mock('@vercel/blob', () => ({
  put: (...args: any[]) => mockPut(...args),
  del: (...args: any[]) => mockDel(...args),
  head: (...args: any[]) => mockHead(...args),
}));

import { VercelBlobStorageProvider } from '../vercel-blob-storage.provider';

function makeConfig(values: Record<string, string>) {
  return { get: (key: string, def = '') => values[key] ?? def } as any;
}

describe('VercelBlobStorageProvider', () => {
  afterEach(() => jest.clearAllMocks());

  it('throws when BLOB_READ_WRITE_TOKEN is missing', () => {
    expect(() => new VercelBlobStorageProvider(makeConfig({}))).toThrow(
      'BLOB_READ_WRITE_TOKEN environment variable is required',
    );
  });

  it('creates successfully with token', () => {
    expect(
      () =>
        new VercelBlobStorageProvider(
          makeConfig({ BLOB_READ_WRITE_TOKEN: 'token123' }),
        ),
    ).not.toThrow();
  });

  describe('upload', () => {
    it('uploads file and returns result', async () => {
      mockPut.mockResolvedValue({
        pathname: 'file.txt',
        url: 'https://vercel.blob/file.txt',
      });
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      const result = await provider.upload(Buffer.from('data'), 'file.txt');
      expect(result.key).toBe('file.txt');
      expect(result.url).toBe('https://vercel.blob/file.txt');
      expect(result.provider).toBe(StorageProvider.VERCEL_BLOB);
      expect(result.size).toBe(4);
    });

    it('uploads with folder', async () => {
      mockPut.mockResolvedValue({ pathname: 'imgs/photo.png', url: 'https://url' });
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      const result = await provider.upload(Buffer.from('x'), 'photo.png', {
        folder: 'imgs',
      });
      expect(result.key).toBe('imgs/photo.png');
    });

    it('passes mimeType when provided', async () => {
      mockPut.mockResolvedValue({ pathname: 'f.txt', url: 'https://url' });
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      await provider.upload(Buffer.from('x'), 'f.txt', {
        mimeType: 'text/plain',
      });
      expect(mockPut).toHaveBeenCalledWith(
        'f.txt',
        expect.any(Buffer),
        expect.objectContaining({ contentType: 'text/plain' }),
      );
    });

    it('throws on upload failure', async () => {
      mockPut.mockRejectedValue(new Error('upload error'));
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      await expect(provider.upload(Buffer.from('x'), 'f.txt')).rejects.toThrow(
        'Vercel Blob upload failed: upload error',
      );
    });
  });

  describe('delete', () => {
    it('deletes successfully', async () => {
      mockDel.mockResolvedValue({});
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      await expect(provider.delete('file.txt')).resolves.toBeUndefined();
    });

    it('throws on failure', async () => {
      mockDel.mockRejectedValue(new Error('delete error'));
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      await expect(provider.delete('file.txt')).rejects.toThrow(
        'Vercel Blob delete failed: delete error',
      );
    });
  });

  describe('getUrl', () => {
    it('returns URL from head', async () => {
      mockHead.mockResolvedValue({ url: 'https://vercel.blob/file.txt' });
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      expect(await provider.getUrl('file.txt')).toBe(
        'https://vercel.blob/file.txt',
      );
    });

    it('throws on failure', async () => {
      mockHead.mockRejectedValue(new Error('head error'));
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      await expect(provider.getUrl('file.txt')).rejects.toThrow(
        'Vercel Blob getUrl failed: head error',
      );
    });
  });

  describe('exists', () => {
    it('returns true when file exists', async () => {
      mockHead.mockResolvedValue({ url: 'https://url' });
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      expect(await provider.exists('file.txt')).toBe(true);
    });

    it('returns false on 404', async () => {
      const err: any = new Error('not found');
      err.status = 404;
      mockHead.mockRejectedValue(err);
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      expect(await provider.exists('file.txt')).toBe(false);
    });

    it('throws on non-404 errors', async () => {
      mockHead.mockRejectedValue(new Error('server error'));
      const provider = new VercelBlobStorageProvider(
        makeConfig({ BLOB_READ_WRITE_TOKEN: 'tok' }),
      );
      await expect(provider.exists('file.txt')).rejects.toThrow(
        'Vercel Blob exists check failed: server error',
      );
    });
  });
});
