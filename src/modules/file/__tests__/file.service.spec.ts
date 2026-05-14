import { Logger } from '@nestjs/common';
import { FileService } from '../file.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

function makePrisma() {
  return {
    file: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'file-1', storage_key: 'key/file.jpg' }),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'file-1', storage_key: 'key/file.jpg' }),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeStorageService() {
  return {
    upload: jest.fn().mockResolvedValue({
      url: 'https://cdn.example.com/file.jpg',
      key: 'folder/file.jpg',
      bucket: 'my-bucket',
      provider: 'cloudflare',
    }),
    getUrl: jest.fn().mockResolvedValue('https://cdn.example.com/file.jpg'),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

function makeWatermarkService() {
  return {
    addWatermark: jest
      .fn()
      .mockImplementation((buf: Buffer) => Promise.resolve(buf)),
  };
}

function makeFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'photo.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    buffer: Buffer.from('fake'),
    size: 4,
    destination: '',
    filename: 'photo.jpg',
    path: '',
    stream: null as any,
    ...overrides,
  };
}

describe('FileService', () => {
  let service: FileService;
  let prisma: ReturnType<typeof makePrisma>;
  let storage: ReturnType<typeof makeStorageService>;
  let watermark: ReturnType<typeof makeWatermarkService>;

  beforeEach(() => {
    prisma = makePrisma();
    storage = makeStorageService();
    watermark = makeWatermarkService();
    service = new FileService(prisma as any, storage as any, watermark as any);
  });

  describe('uploadToStorage()', () => {
    it('applies watermark for image files', async () => {
      const file = makeFile({ mimetype: 'image/jpeg' });
      await service.uploadToStorage(file);
      expect(watermark.addWatermark).toHaveBeenCalledWith(
        file.buffer,
        'image/jpeg',
      );
    });

    it('does not apply watermark for non-image files', async () => {
      const file = makeFile({ mimetype: 'application/pdf' });
      await service.uploadToStorage(file);
      expect(watermark.addWatermark).not.toHaveBeenCalled();
    });

    it('throws when buffer is missing', async () => {
      const file = makeFile({ buffer: undefined as any });
      await expect(service.uploadToStorage(file)).rejects.toThrow();
    });

    it('returns upload result with originalFilename and mimeType', async () => {
      const file = makeFile({
        mimetype: 'image/png',
        originalname: 'test.png',
        size: 100,
      });
      const result = await service.uploadToStorage(file);
      expect(result.originalFilename).toBe('test.png');
      expect(result.mimeType).toBe('image/png');
      expect(result.size).toBe(100);
    });

    it('passes folder option to storage service', async () => {
      const file = makeFile();
      await service.uploadToStorage(file, { folder: 'avatars' });
      expect(storage.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        'photo.jpg',
        expect.objectContaining({ folder: 'avatars' }),
      );
    });
  });

  describe('uploadFile()', () => {
    it('creates a db record and returns with url', async () => {
      const file = makeFile();
      const result = await service.uploadFile(file, { profileId: 'p-1' });
      expect(prisma.file.create).toHaveBeenCalled();
      expect(result.url).toBeDefined();
    });

    it('rethrows upload error', async () => {
      storage.upload.mockRejectedValueOnce(new Error('Storage down'));
      const file = makeFile();
      await expect(service.uploadFile(file)).rejects.toThrow('Storage down');
    });
  });

  describe('getFile()', () => {
    it('returns file with url', async () => {
      const result = await service.getFile('file-1');
      expect(result.url).toBeDefined();
      expect(storage.getUrl).toHaveBeenCalledWith(
        'key/file.jpg',
        expect.any(Object),
      );
    });

    it('throws NotFoundException when file not found', async () => {
      prisma.file.findUnique.mockResolvedValueOnce(null);
      await expect(service.getFile('missing')).rejects.toThrow('not found');
    });
  });

  describe('deleteFile()', () => {
    it('deletes from storage and db', async () => {
      await service.deleteFile('file-1');
      expect(storage.delete).toHaveBeenCalledWith('key/file.jpg');
      expect(prisma.file.delete).toHaveBeenCalledWith({
        where: { id: 'file-1' },
      });
    });

    it('throws NotFoundException when file not found', async () => {
      prisma.file.findUnique.mockResolvedValueOnce(null);
      await expect(service.deleteFile('missing')).rejects.toThrow('not found');
    });

    it('rethrows storage error', async () => {
      storage.delete.mockRejectedValueOnce(new Error('Delete failed'));
      await expect(service.deleteFile('file-1')).rejects.toThrow(
        'Delete failed',
      );
    });
  });

  describe('getFilesByProfile()', () => {
    it('returns empty array when no files', async () => {
      const result = await service.getFilesByProfile('p-1');
      expect(result).toEqual([]);
    });

    it('returns files with urls', async () => {
      prisma.file.findMany.mockResolvedValueOnce([
        { id: 'f1', storage_key: 'k1' },
        { id: 'f2', storage_key: 'k2' },
      ]);
      const result = await service.getFilesByProfile('p-1');
      expect(result).toHaveLength(2);
      expect(result[0].url).toBeDefined();
    });
  });
});
