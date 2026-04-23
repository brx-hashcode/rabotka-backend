import { Test, TestingModule } from '@nestjs/testing';
import { DeliveryChannel } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../common/services/prisma/prisma.service';
import { AdLinkTrackingService } from '../ad-link-tracking.service';

describe('AdLinkTrackingService', () => {
  let service: AdLinkTrackingService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPrismaService = {
      adTrackedLink: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      advertisement: {
        update: jest.fn(),
      },
      adDeliveryLog: {
        updateMany: jest.fn(),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdLinkTrackingService,
        { provide: PrismaService, useValue: mockPrismaService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'FRONTEND_URL' ? 'https://app.rabotka.co' : undefined,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<AdLinkTrackingService>(AdLinkTrackingService);
    prisma = module.get(PrismaService);
  });

  it('rewrites URL-like fields to tracked short links', async () => {
    (prisma.adTrackedLink.create as jest.Mock)
      .mockResolvedValueOnce({ id: 'tl-1', hash: 'abc123' })
      .mockResolvedValueOnce({ id: 'tl-2', hash: 'def456' });

    const result = await service.buildTrackedPayload({
      advertisementId: 'ad-1',
      deliveryLogId: 'dl-1',
      channel: DeliveryChannel.EMAIL,
      payload: {
        advertisementId: 'ad-1',
        title: 'Offer',
        startDate: new Date().toISOString(),
        endDate: new Date().toISOString(),
        description:
          'Read https://example.com/docs and visit https://example.com/docs',
        ctaUrl: 'https://example.com/apply',
      },
    });

    expect(prisma.adTrackedLink.create).toHaveBeenCalledTimes(2);
    expect(result.description).toContain('https://app.rabotka.co/r/');
    expect(result.ctaUrl).toContain('https://app.rabotka.co/r/');
    expect(result.description).not.toContain('https://example.com/docs');
    expect(result.ctaUrl).not.toContain('https://example.com/apply');
  });

  it('records click and returns original URL', async () => {
    (prisma.adTrackedLink.findUnique as jest.Mock).mockResolvedValue({
      id: 'tl-1',
      advertisement_id: 'ad-1',
      ad_delivery_log_id: 'dl-1',
      original_url: 'https://example.com/original',
    });

    const originalUrl = await service.resolveAndTrackClick('abc123', {
      ip: '10.0.0.1',
      userAgent: 'jest-agent',
    });

    expect(originalUrl).toBe('https://example.com/original');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.adTrackedLink.update).toHaveBeenCalledTimes(1);
    expect(prisma.advertisement.update).toHaveBeenCalledTimes(1);
    expect(prisma.adDeliveryLog.updateMany).toHaveBeenCalledTimes(1);
  });

  it('throws when tracking hash does not exist', async () => {
    (prisma.adTrackedLink.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(
      service.resolveAndTrackClick('missing', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
