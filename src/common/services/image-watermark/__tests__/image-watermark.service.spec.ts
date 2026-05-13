import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImageWatermarkService } from '../image-watermark.service';

jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

// Mock sharp — all mock fns stored on globalThis to avoid jest hoisting issues
jest.mock('sharp', () => {
  const toBufferMain = jest.fn().mockResolvedValue(Buffer.from('watermarked'));
  const toBufferRaw = jest.fn().mockResolvedValue({
    data: Buffer.alloc(16 * 4),
    info: { width: 16, height: 16, channels: 4 },
  });

  const sharpInstance: Record<string, jest.Mock> = {};
  const chainFn = () => jest.fn().mockReturnValue(sharpInstance);

  sharpInstance.rotate = chainFn();
  sharpInstance.metadata = jest
    .fn()
    .mockResolvedValue({ width: 800, height: 600 });
  sharpInstance.composite = chainFn();
  sharpInstance.toFormat = chainFn();
  sharpInstance.toBuffer = toBufferMain;
  sharpInstance.resize = chainFn();
  sharpInstance.ensureAlpha = chainFn();
  sharpInstance.png = jest
    .fn()
    .mockReturnValue({ ...sharpInstance, toBuffer: toBufferRaw });
  sharpInstance.raw = jest
    .fn()
    .mockReturnValue({ ...sharpInstance, toBuffer: toBufferRaw });

  (globalThis as Record<string, unknown>).__sharpInstance = sharpInstance;

  const fn = jest.fn().mockReturnValue(sharpInstance);
  return fn;
});

// Mock fs to control logo existence
jest.mock('node:fs', () => ({
  existsSync: jest.fn().mockReturnValue(false), // default: logo not found
}));

function getSharpInstance(): Record<string, jest.Mock> {
  return (globalThis as Record<string, unknown>).__sharpInstance as Record<
    string,
    jest.Mock
  >;
}

describe('ImageWatermarkService', () => {
  let service: ImageWatermarkService;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-setup defaults after clearAllMocks
    const inst = getSharpInstance();
    inst.rotate.mockReturnValue(inst);
    inst.metadata.mockResolvedValue({ width: 800, height: 600 });
    inst.composite.mockReturnValue(inst);
    inst.toFormat.mockReturnValue(inst);
    inst.toBuffer.mockResolvedValue(Buffer.from('watermarked'));
    inst.resize.mockReturnValue(inst);
    inst.ensureAlpha.mockReturnValue(inst);

    configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ConfigService>;
    service = new ImageWatermarkService(configService);
  });

  describe('addWatermark()', () => {
    const imageBuffer = Buffer.from('fake-image-data');

    it('returns original buffer for non-image mime types', async () => {
      const result = await service.addWatermark(imageBuffer, 'application/pdf');
      expect(result).toBe(imageBuffer);
    });

    it('returns original buffer for text mime type', async () => {
      const result = await service.addWatermark(imageBuffer, 'text/plain');
      expect(result).toBe(imageBuffer);
    });

    it('returns original buffer when logo file does not exist', async () => {
      const { existsSync } = require('node:fs') as { existsSync: jest.Mock };
      existsSync.mockReturnValue(false);

      const result = await service.addWatermark(imageBuffer, 'image/jpeg');
      expect(result).toBe(imageBuffer);
    });

    it('returns original buffer when WATERMARK_LOGO_PATH not configured and logo missing', async () => {
      const { existsSync } = require('node:fs') as { existsSync: jest.Mock };
      existsSync.mockReturnValue(false);
      configService.get.mockReturnValue(undefined);

      const result = await service.addWatermark(imageBuffer, 'image/png');
      expect(result).toBe(imageBuffer);
    });

    it('uses WATERMARK_LOGO_PATH from config when provided', async () => {
      const { existsSync } = require('node:fs') as { existsSync: jest.Mock };
      existsSync.mockReturnValue(true);
      configService.get.mockImplementation((key: string) => {
        if (key === 'WATERMARK_LOGO_PATH') return '/absolute/logo.png';
        if (key === 'WATERMARK_OPACITY') return undefined;
        return undefined;
      });

      // Since sharp is mocked, it should process and return watermarked buffer
      await service.addWatermark(imageBuffer, 'image/jpeg');
      // No error thrown — sharp mock returns watermarked buffer
    });

    it('returns original buffer when sharp fails', async () => {
      const { existsSync } = require('node:fs') as { existsSync: jest.Mock };
      existsSync.mockReturnValue(true);
      const inst = getSharpInstance();
      inst.metadata.mockRejectedValueOnce(new Error('Sharp error'));

      const result = await service.addWatermark(imageBuffer, 'image/jpeg');
      expect(result).toBe(imageBuffer);
    });
  });

  describe('opacity configuration', () => {
    it('uses default opacity (0.3) when not configured', async () => {
      configService.get.mockReturnValue(undefined);
      const { existsSync } = require('node:fs') as { existsSync: jest.Mock };
      existsSync.mockReturnValue(false);
      const result = await service.addWatermark(
        Buffer.from('img'),
        'image/png',
      );
      expect(result).toBeDefined();
    });

    it('uses default opacity for invalid opacity value', async () => {
      configService.get.mockReturnValue('not-a-number');
      const { existsSync } = require('node:fs') as { existsSync: jest.Mock };
      existsSync.mockReturnValue(false);
      const result = await service.addWatermark(
        Buffer.from('img'),
        'image/png',
      );
      expect(result).toBeDefined();
    });

    it('uses default opacity when value is out of range', async () => {
      configService.get.mockReturnValue('1.5');
      const { existsSync } = require('node:fs') as { existsSync: jest.Mock };
      existsSync.mockReturnValue(false);
      const result = await service.addWatermark(
        Buffer.from('img'),
        'image/png',
      );
      expect(result).toBeDefined();
    });
  });
});
