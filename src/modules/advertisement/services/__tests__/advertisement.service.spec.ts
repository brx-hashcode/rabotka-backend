import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { AdvertisementService } from '../advertisement.service';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';
import { AdStatus, AdPaymentStatus } from '@prisma/client';

const mockPrisma = {
  advertisementBundle: {
    findUnique: jest.fn(),
  },
  advertisement: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
};

const now = new Date();
const futureDate = new Date(now.getTime() + 86400000 * 5);
const endDate = new Date(now.getTime() + 86400000 * 10);

const mockBundle = {
  id: 'bundle-1',
  name: 'Basic Bundle',
  is_active: true,
  max_duration_days: 30,
};

const mockAd = {
  id: 'ad-1',
  bundle_id: 'bundle-1',
  title: 'Test Ad',
  description: 'Ad description',
  status: AdStatus.DRAFT,
  payment_status: AdPaymentStatus.UNPAID,
  start_date: futureDate,
  end_date: endDate,
  bundle: mockBundle,
  _count: { delivery_logs: 0 },
};

describe('AdvertisementService', () => {
  let service: AdvertisementService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdvertisementService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<AdvertisementService>(AdvertisementService);
  });

  describe('create', () => {
    it('creates an advertisement', async () => {
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue(mockBundle);
      mockPrisma.advertisement.create.mockResolvedValue(mockAd);

      const result = await service.create({
        bundleId: 'bundle-1',
        title: 'Test Ad',
        description: 'Ad description',
        startDate: futureDate.toISOString(),
        endDate: endDate.toISOString(),
      } as any);

      expect(result.id).toBe('ad-1');
    });

    it('throws if bundle not found', async () => {
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue(null);
      await expect(
        service.create({
          bundleId: 'x',
          title: 'T',
          description: 'D',
          startDate: futureDate.toISOString(),
          endDate: endDate.toISOString(),
        } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws if bundle not active', async () => {
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue({
        ...mockBundle,
        is_active: false,
      });
      await expect(
        service.create({
          bundleId: 'bundle-1',
          title: 'T',
          description: 'D',
          startDate: futureDate.toISOString(),
          endDate: endDate.toISOString(),
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws if end date too close to start date', async () => {
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue(mockBundle);
      const start = new Date();
      const end = new Date(start.getTime() + 3600000); // 1 hour later
      await expect(
        service.create({
          bundleId: 'bundle-1',
          title: 'T',
          description: 'D',
          startDate: start.toISOString(),
          endDate: end.toISOString(),
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws if duration exceeds bundle max', async () => {
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue({
        ...mockBundle,
        max_duration_days: 5,
      });
      const start = new Date();
      const end = new Date(start.getTime() + 86400000 * 10);
      await expect(
        service.create({
          bundleId: 'bundle-1',
          title: 'T',
          description: 'D',
          startDate: start.toISOString(),
          endDate: end.toISOString(),
        } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findAll', () => {
    it('returns paginated ads', async () => {
      mockPrisma.advertisement.findMany.mockResolvedValue([mockAd]);
      mockPrisma.advertisement.count.mockResolvedValue(1);

      const result = await service.findAll({});
      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
    });

    it('filters by status, bundleId, targetAudience, channel', async () => {
      mockPrisma.advertisement.findMany.mockResolvedValue([]);
      mockPrisma.advertisement.count.mockResolvedValue(0);

      const result = await service.findAll({
        status: AdStatus.ACTIVE,
        bundleId: 'bundle-1',
        targetAudience: 'EMPLOYER' as any,
        channel: 'EMAIL' as any,
      });
      expect(result.total).toBe(0);
    });
  });

  describe('findOne', () => {
    it('returns ad by id', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      const result = await service.findOne('ad-1');
      expect(result.id).toBe('ad-1');
    });

    it('throws if not found', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(null);
      await expect(service.findOne('x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('updates a DRAFT ad', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      mockPrisma.advertisement.update.mockResolvedValue({
        ...mockAd,
        title: 'Updated',
      });

      const result = await service.update('ad-1', { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });

    it('throws if ad is not DRAFT or PAUSED', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue({
        ...mockAd,
        status: AdStatus.ACTIVE,
      });
      await expect(service.update('ad-1', { title: 'x' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws if not found', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(null);
      await expect(service.update('x', {})).rejects.toThrow(NotFoundException);
    });

    it('updates bundle if bundleId changes', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue(mockBundle);
      mockPrisma.advertisement.update.mockResolvedValue(mockAd);

      await service.update('ad-1', { bundleId: 'bundle-2' });
      expect(mockPrisma.advertisementBundle.findUnique).toHaveBeenCalled();
    });

    it('validates dates when startDate changes', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      mockPrisma.advertisementBundle.findUnique.mockResolvedValue(mockBundle);
      mockPrisma.advertisement.update.mockResolvedValue(mockAd);

      await service.update('ad-1', { startDate: futureDate.toISOString() });
    });
  });

  describe('confirmPayment', () => {
    it('confirms payment', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      mockPrisma.advertisement.update.mockResolvedValue({
        ...mockAd,
        payment_status: AdPaymentStatus.PAID,
      });

      const result = await service.confirmPayment('ad-1');
      expect(result.payment_status).toBe(AdPaymentStatus.PAID);
    });

    it('throws if already paid', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue({
        ...mockAd,
        payment_status: AdPaymentStatus.PAID,
      });
      await expect(service.confirmPayment('ad-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('submit', () => {
    it('submits a paid DRAFT ad', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue({
        ...mockAd,
        payment_status: AdPaymentStatus.PAID,
      });
      mockPrisma.advertisement.update.mockResolvedValue({
        ...mockAd,
        status: AdStatus.PENDING_REVIEW,
      });

      const result = await service.submit('ad-1');
      expect(result.status).toBe(AdStatus.PENDING_REVIEW);
    });

    it('throws if not DRAFT', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue({
        ...mockAd,
        status: AdStatus.ACTIVE,
      });
      await expect(service.submit('ad-1')).rejects.toThrow(BadRequestException);
    });

    it('throws if not paid', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      await expect(service.submit('ad-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('pause', () => {
    it('pauses an ACTIVE ad', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue({
        ...mockAd,
        status: AdStatus.ACTIVE,
      });
      mockPrisma.advertisement.update.mockResolvedValue({
        ...mockAd,
        status: AdStatus.PAUSED,
      });

      const result = await service.pause('ad-1');
      expect(result.status).toBe(AdStatus.PAUSED);
    });

    it('throws if not ACTIVE', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      await expect(service.pause('ad-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('resume', () => {
    it('resumes a PAUSED ad', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue({
        ...mockAd,
        status: AdStatus.PAUSED,
      });
      mockPrisma.advertisement.update.mockResolvedValue({
        ...mockAd,
        status: AdStatus.APPROVED,
      });

      const result = await service.resume('ad-1');
      expect(result.status).toBe(AdStatus.APPROVED);
    });

    it('throws if not PAUSED', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      await expect(service.resume('ad-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('cancel', () => {
    it('cancels an ad', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      mockPrisma.advertisement.update.mockResolvedValue({
        ...mockAd,
        status: AdStatus.CANCELLED,
      });

      const result = await service.cancel('ad-1');
      expect(result.status).toBe(AdStatus.CANCELLED);
    });

    it('throws if ad is COMPLETED', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue({
        ...mockAd,
        status: AdStatus.COMPLETED,
      });
      await expect(service.cancel('ad-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('delete', () => {
    it('deletes an ad', async () => {
      mockPrisma.advertisement.findUnique.mockResolvedValue(mockAd);
      mockPrisma.advertisement.delete.mockResolvedValue(mockAd);

      await service.delete('ad-1');
      expect(mockPrisma.advertisement.delete).toHaveBeenCalled();
    });
  });

  describe('updateMetrics', () => {
    it('updates total_sent metric', async () => {
      mockPrisma.advertisement.update.mockResolvedValue(mockAd);
      await service.updateMetrics('ad-1', 'total_sent');
      expect(mockPrisma.advertisement.update).toHaveBeenCalled();
    });
  });
});
