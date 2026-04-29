import { Logger } from '@nestjs/common';
import { StorageService } from '../storage.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

function makeProvider() {
  return {
    upload: jest.fn().mockResolvedValue({
      url: 'https://cdn.example.com/file.jpg',
      key: 'file.jpg',
      bucket: 'b',
      provider: 'S3',
    }),
    delete: jest.fn().mockResolvedValue(undefined),
    getUrl: jest.fn().mockResolvedValue('https://cdn.example.com/file.jpg'),
    exists: jest.fn().mockResolvedValue(true),
  };
}

function makeFactory(provider: ReturnType<typeof makeProvider> | null) {
  return { create: jest.fn().mockReturnValue(provider) };
}

describe('StorageService', () => {
  describe('onModuleInit()', () => {
    it('creates provider from factory', () => {
      const provider = makeProvider();
      const factory = makeFactory(provider);
      const service = new StorageService(factory as any);
      service.onModuleInit();
      expect(factory.create).toHaveBeenCalled();
    });

    it('logs warning when factory is null', () => {
      const service = new StorageService(null as any);
      service.onModuleInit(); // should not throw
    });
  });

  describe('after init', () => {
    let service: StorageService;
    let provider: ReturnType<typeof makeProvider>;

    beforeEach(() => {
      provider = makeProvider();
      service = new StorageService(makeFactory(provider) as any);
      service.onModuleInit();
    });

    it('upload() delegates to provider', async () => {
      const buf = Buffer.from('data');
      await service.upload(buf, 'file.jpg', { mimeType: 'image/jpeg' });
      expect(provider.upload).toHaveBeenCalledWith(buf, 'file.jpg', {
        mimeType: 'image/jpeg',
      });
    });

    it('delete() delegates to provider', async () => {
      await service.delete('file.jpg');
      expect(provider.delete).toHaveBeenCalledWith('file.jpg');
    });

    it('getUrl() delegates to provider', async () => {
      const url = await service.getUrl('file.jpg');
      expect(url).toBe('https://cdn.example.com/file.jpg');
    });

    it('exists() delegates to provider', async () => {
      const result = await service.exists('file.jpg');
      expect(result).toBe(true);
    });
  });

  describe('when not initialized', () => {
    it('upload() throws if provider not initialized', async () => {
      const service = new StorageService({
        create: jest.fn().mockReturnValue(null),
      } as any);
      // Not calling onModuleInit — provider stays null
      await expect(service.upload(Buffer.from('x'), 'f.jpg')).rejects.toThrow(
        'not initialized',
      );
    });
  });
});
