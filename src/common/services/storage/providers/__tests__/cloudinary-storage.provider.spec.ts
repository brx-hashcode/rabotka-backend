import { Logger } from '@nestjs/common';
import { StorageProvider } from '@prisma/client';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const mockUploadStream = jest.fn();
const mockDestroy = jest.fn();
const mockUrl = jest.fn();
const mockApiResource = jest.fn();

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: {
      upload_stream: mockUploadStream,
      destroy: mockDestroy,
    },
    url: mockUrl,
    api: {
      resource: mockApiResource,
    },
  },
}));

import { CloudinaryStorageProvider } from '../cloudinary-storage.provider';

function makeConfig(values: Record<string, string>) {
  return { get: (key: string) => values[key] } as any;
}

const baseConfig = {
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'api-key',
  CLOUDINARY_API_SECRET: 'api-secret',
};

describe('CloudinaryStorageProvider', () => {
  afterEach(() => jest.clearAllMocks());

  it('throws when credentials are missing', () => {
    expect(() => new CloudinaryStorageProvider(makeConfig({}))).toThrow(
      'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET environment variables are required',
    );
  });

  it('creates successfully with valid config', () => {
    expect(() => new CloudinaryStorageProvider(makeConfig(baseConfig))).not.toThrow();
  });

  describe('upload', () => {
    function setupUploadStream(
      error: any,
      result: any,
    ): { writtenBuffer: Buffer | null } {
      const state = { writtenBuffer: null as Buffer | null };
      mockUploadStream.mockImplementation((_opts: any, callback: Function) => {
        const stream = {
          end: (buf: Buffer) => {
            state.writtenBuffer = buf;
            callback(error, result);
          },
        };
        return stream;
      });
      return state;
    }

    it('uploads and returns result', async () => {
      setupUploadStream(null, {
        public_id: 'uploads/file',
        secure_url: 'https://cloudinary.com/file',
        bytes: 100,
      });
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      const result = await provider.upload(Buffer.from('data'), 'file.jpg');
      expect(result.key).toBe('uploads/file');
      expect(result.url).toBe('https://cloudinary.com/file');
      expect(result.provider).toBe(StorageProvider.CLOUDINARY);
      expect(result.size).toBe(100);
    });

    it('uses url when secure_url is absent', async () => {
      setupUploadStream(null, {
        public_id: 'file',
        url: 'http://cloudinary.com/file',
        bytes: 50,
      });
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      const result = await provider.upload(Buffer.from('x'), 'file.jpg');
      expect(result.url).toBe('http://cloudinary.com/file');
    });

    it('uploads with folder prefix', async () => {
      setupUploadStream(null, {
        public_id: 'folder/file',
        secure_url: 'https://url',
        bytes: 5,
      });
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      await provider.upload(Buffer.from('x'), 'file.jpg', { folder: 'folder' });
      expect(mockUploadStream).toHaveBeenCalledWith(
        expect.objectContaining({ public_id: 'folder/file' }),
        expect.any(Function),
      );
    });

    it('rejects when cloudinary returns error', async () => {
      setupUploadStream(new Error('upload failed'), null);
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      await expect(provider.upload(Buffer.from('x'), 'f.jpg')).rejects.toThrow(
        'Cloudinary upload failed: upload failed',
      );
    });

    it('rejects when result is null', async () => {
      setupUploadStream(null, null);
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      await expect(provider.upload(Buffer.from('x'), 'f.jpg')).rejects.toThrow(
        'Cloudinary upload returned no result',
      );
    });
  });

  describe('delete', () => {
    it('deletes successfully', async () => {
      mockDestroy.mockImplementation((_key: string, callback: Function) => {
        callback(null, { result: 'ok' });
      });
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      await expect(provider.delete('file')).resolves.toBeUndefined();
    });

    it('resolves when file not found (not-found result)', async () => {
      mockDestroy.mockImplementation((_key: string, callback: Function) => {
        callback(null, { result: 'not found' });
      });
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      await expect(provider.delete('file')).resolves.toBeUndefined();
    });

    it('rejects on error', async () => {
      mockDestroy.mockImplementation((_key: string, callback: Function) => {
        callback(new Error('delete error'), null);
      });
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      await expect(provider.delete('file')).rejects.toThrow(
        'Cloudinary delete failed: delete error',
      );
    });
  });

  describe('getUrl', () => {
    it('returns cloudinary URL', async () => {
      mockUrl.mockReturnValue('https://cloudinary.com/img');
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      expect(await provider.getUrl('img')).toBe('https://cloudinary.com/img');
    });
  });

  describe('exists', () => {
    it('returns true when resource exists', async () => {
      mockApiResource.mockImplementation((_key: string, callback: Function) => {
        callback(null, { public_id: 'img' });
      });
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      expect(await provider.exists('img')).toBe(true);
    });

    it('returns false on 404 error', async () => {
      mockApiResource.mockImplementation((_key: string, callback: Function) => {
        callback({ http_code: 404 }, null);
      });
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      expect(await provider.exists('img')).toBe(false);
    });

    it('rejects on non-404 error', async () => {
      mockApiResource.mockImplementation((_key: string, callback: Function) => {
        callback({ http_code: 500, message: 'server error' }, null);
      });
      const provider = new CloudinaryStorageProvider(makeConfig(baseConfig));
      await expect(provider.exists('img')).rejects.toThrow(
        'Cloudinary exists check failed: server error',
      );
    });
  });
});
