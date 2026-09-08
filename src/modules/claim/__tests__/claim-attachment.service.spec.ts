import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ClaimAttachmentService } from '../claim-attachment.service';
import { FileService } from '../../file/file.service';
import { SystemConfigService } from '../../system-config/system-config.service';

const PUBLIC_BASE = 'https://cdn.rabotka.test';

const mockFileService = {
  uploadToStorage: jest.fn(),
};

/** Only the storage names `storageNames` reads. */
const mockSystemConfig = {
  get: jest.fn((key: string, fallback: string) => {
    if (key === 'storage.cloudflare.public_base_url')
      return Promise.resolve(PUBLIC_BASE);
    if (key === 'storage.cloudflare.bucket_name')
      return Promise.resolve('rabotka-public');
    if (key === 'storage.cloudflare.kyc_bucket_name')
      return Promise.resolve('rabotka-kyc');
    return Promise.resolve(fallback);
  }),
};

const mockConfig = { get: (_k: string, d: string) => d };

const file = (over: Partial<Express.Multer.File> = {}) =>
  ({
    fieldname: 'files',
    originalname: 'photo.jpg',
    mimetype: 'image/jpeg',
    size: 2048,
    buffer: Buffer.from('x'),
    ...over,
  }) as Express.Multer.File;

describe('ClaimAttachmentService', () => {
  let service: ClaimAttachmentService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaimAttachmentService,
        { provide: FileService, useValue: mockFileService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: SystemConfigService, useValue: mockSystemConfig },
      ],
    }).compile();
    service = module.get(ClaimAttachmentService);
  });

  describe('uploadMany', () => {
    beforeEach(() => {
      mockFileService.uploadToStorage.mockResolvedValue({
        url: `${PUBLIC_BASE}/claim-attachments/1_ab.jpg`,
        key: 'claim-attachments/1_ab.jpg',
        provider: 'CLOUDFLARE',
      });
    });

    it('writes to the claim folder, public, unwatermarked', async () => {
      await service.uploadMany([file()]);

      expect(mockFileService.uploadToStorage).toHaveBeenCalledWith(
        expect.anything(),
        {
          folder: 'claim-attachments',
          access: 'public',
          watermark: false,
        },
      );
    });

    it('renames the file so the stored key cannot claim a type it is not', async () => {
      await service.uploadMany([
        file({ originalname: 'payload.svg', mimetype: 'image/jpeg' }),
      ]);

      const [passed] = mockFileService.uploadToStorage.mock.calls[0] as [
        Express.Multer.File,
      ];
      expect(passed.originalname).toBe('image.jpg');
    });

    it('reports the original filename back, not the normalised one', async () => {
      const [result] = await service.uploadMany([
        file({ originalname: 'chantier.jpg' }),
      ]);
      expect(result.name).toBe('chantier.jpg');
      expect(result.key).toBe('claim-attachments/1_ab.jpg');
    });

    it('refuses an empty upload', async () => {
      await expect(service.uploadMany([])).rejects.toThrow(BadRequestException);
    });

    it('refuses more files than the cap', async () => {
      await expect(
        service.uploadMany([file(), file(), file(), file(), file(), file()]),
      ).rejects.toThrow(BadRequestException);
      expect(mockFileService.uploadToStorage).not.toHaveBeenCalled();
    });
  });

  describe('assertValidUrls', () => {
    it('passes a url we produced', async () => {
      await expect(
        service.assertValidUrls([
          `${PUBLIC_BASE}/claim-attachments/1757_ab.jpg`,
        ]),
      ).resolves.toBeUndefined();
    });

    it('passes an empty or absent list without asking storage anything', async () => {
      await expect(service.assertValidUrls(undefined)).resolves.toBeUndefined();
      await expect(service.assertValidUrls([])).resolves.toBeUndefined();
      expect(mockSystemConfig.get).not.toHaveBeenCalled();
    });

    it('refuses a foreign host', async () => {
      await expect(
        service.assertValidUrls(['https://evil.test/claim-attachments/x.jpg']),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a host that merely starts with ours', async () => {
      // `deriveKey` requires the trailing slash for exactly this reason.
      await expect(
        service.assertValidUrls([
          `${PUBLIC_BASE}.evil.test/claim-attachments/x.jpg`,
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses another folder on our own CDN', async () => {
      await expect(
        service.assertValidUrls([`${PUBLIC_BASE}/kyc-documents/passport.jpg`]),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a non-image in the right folder', async () => {
      await expect(
        service.assertValidUrls([`${PUBLIC_BASE}/claim-attachments/x.svg`]),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses the whole list when one entry is bad', async () => {
      await expect(
        service.assertValidUrls([
          `${PUBLIC_BASE}/claim-attachments/ok.jpg`,
          'https://evil.test/x.jpg',
        ]),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses more urls than the cap', async () => {
      const many = Array.from(
        { length: 6 },
        (_, i) => `${PUBLIC_BASE}/claim-attachments/${i}.jpg`,
      );
      await expect(service.assertValidUrls(many)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
