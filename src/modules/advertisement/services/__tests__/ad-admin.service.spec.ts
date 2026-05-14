import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AdAdminService } from '../ad-admin.service';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';
import { AdStatus } from '@prisma/client';

const mockPrisma = {
  advertisement: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
  advertisementBundle: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

const mockBundle = {
  id: 'bundle-1',
  name: 'Basic Bundle',
  is_active: true,
  max_duration_days: 30,
  created_at: new Date(),
};

const mockAd = {
  id: 'ad-1',
  status: AdStatus.PENDING_REVIEW,
  bundle_id: 'bundle-1',
};

describe('AdAdminService', () => {
  let service: AdAdminService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdAdminService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<AdAdminService>(AdAdminService);
  });

  describe('approve', () => {
    it('approves a PENDING_REVIEW ad', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      mockPrisma.advertisement.update.mockResolvedValue({ ...mockAd, status: AdStatus.APPROVED });

      const result = await service.approve('ad-1');
      expect(result.status).toBe(AdStatus.APPROVED);
    });

    it('throws NotFoundException if not found', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(null);
      await expect(service.approve('x')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException if not PENDING_REVIEW', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue({ ...mockAd, status: AdStatus.DRAFT });
      await expect(service.approve('ad-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('reject', () => {
    it('rejects a PENDING_REVIEW ad', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      mockPrisma.advertisement.update.mockResolvedValue({ ...mockAd, status: AdStatus.REJECTED });

      const result = await service.reject('ad-1', 'Not acceptable');
      expect(result.status).toBe(AdStatus.REJECTED);
    });

    it('throws NotFoundException if not found', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(null);
      await expect(service.reject('x', 'reason')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException if not PENDING_REVIEW', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue({ ...mockAd, status: AdStatus.ACTIVE });
      await expect(service.reject('ad-1', 'reason')).rejects.toThrow(BadRequestException);
    });
  });

  describe('listPendingReview', () => {
    it('returns pending review ads', async () => {
      mockPrisma.advertisement.findMany.mockResolvedValue([mockAd]);
      const result = await service.listPendingReview();
      expect(result).toHaveLength(1);
    });
  });

  describe('createBundle', () => {
    it('creates a bundle', async () => {
      mockPrisma.advertisementBundle.create.mockResolvedValue(mockBundle);

      const result = await service.createBundle({
        name: 'Basic Bundle',
        price: 10000,
        maxReach: 1000,
        maxFrequencyPerWeek: 3,
        maxDurationDays: 30,
        allowedChannels: ['EMAIL'],
      } as any);

      expect(result.id).toBe('bundle-1');
    });
  });

  describe('updateBundle', () => {
    it('updates a bundle', async () => {
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue(mockBundle);
      mockPrisma.advertisementBundle.update.mockResolvedValue({ ...mockBundle, name: 'Updated' });

      const result = await service.updateBundle('bundle-1', { name: 'Updated' });
      expect(result.name).toBe('Updated');
    });

    it('throws if bundle not found', async () => {
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue(null);
      await expect(service.updateBundle('x', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('listBundles', () => {
    it('returns all bundles', async () => {
      mockPrisma.advertisementBundle.findMany.mockResolvedValue([mockBundle]);
      const result = await service.listBundles();
      expect(result).toHaveLength(1);
    });
  });

  describe('deleteBundle', () => {
    it('deletes a bundle with no ads', async () => {
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue(mockBundle);
      mockPrisma.advertisement.count.mockResolvedValue(0);
      mockPrisma.advertisementBundle.delete.mockResolvedValue(mockBundle);

      await service.deleteBundle('bundle-1');
      expect(mockPrisma.advertisementBundle.delete).toHaveBeenCalled();
    });

    it('throws if bundle not found', async () => {
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue(null);
      await expect(service.deleteBundle('x')).rejects.toThrow(NotFoundException);
    });

    it('throws if bundle has ads', async () => {
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue(mockBundle);
      mockPrisma.advertisement.count.mockResolvedValue(1);
      await expect(service.deleteBundle('bundle-1')).rejects.toThrow(BadRequestException);
    });
  });
});
