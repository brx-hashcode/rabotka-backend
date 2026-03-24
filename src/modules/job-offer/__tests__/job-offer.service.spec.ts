import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JobOfferService } from '../job-offer.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { JobOfferStatus, PaymentFlow } from '@prisma/client';
import { QdrantService } from '../../qdrant/qdrant.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { BotNotificationService } from '../../bot/services/bot-notification.service';

const EMPLOYER_ID = 'employer-uuid-1';
const OFFER_ID = 'offer-uuid-1';
const WORKER_ID = 'worker-uuid-1';

function futureDate(hoursFromNow = 5): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

const baseDto = {
  title: 'Plombier pour urgence',
  description: 'Réparation fuite eau cuisine, remplacement robinet, vérification tuyauterie.',
  scheduled_at: futureDate(5),
  amount: 15000,
  payment_flow: PaymentFlow.DAILY,
  address: '123 Avenue de la Paix, Poto-Poto',
  quantity: 2,
};

const mockOffer = {
  id: OFFER_ID,
  employer_id: EMPLOYER_ID,
  title: 'Plombier pour urgence',
  description: 'Réparation fuite eau cuisine',
  scheduled_at: new Date(futureDate(5)),
  amount: 15000,
  payment_flow: 'DAILY',
  address: '123 Avenue de la Paix, Poto-Poto',
  note: null,
  quantity: 2,
  status: 'ACTIVE',
  created_at: new Date(),
  updated_at: new Date(),
  _count: { applications: 0 },
};

describe('JobOfferService', () => {
  let service: JobOfferService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPrisma = {
      profile: {
        findUnique: jest.fn(),
      },
      jobOffer: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobOfferService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: QdrantService, useValue: { search: jest.fn().mockResolvedValue([]), upsert: jest.fn(), delete: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue('0'), getFees: jest.fn().mockResolvedValue({ jobPostingFeeFcfa: 0, maxConcurrentApplications: 2 }), isSimilarityEnabled: jest.fn().mockResolvedValue(false) } },
        { provide: WhatsAppService, useValue: { sendTextMessage: jest.fn().mockResolvedValue(true) } },
        { provide: BotNotificationService, useValue: { notifyJobOfferCreated: jest.fn(), notifyJobOfferCancelled: jest.fn() } },
      ],
    }).compile();

    service = module.get<JobOfferService>(JobOfferService);
    prisma = module.get(PrismaService);
  });

  describe('create()', () => {
    beforeEach(() => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        id: EMPLOYER_ID,
        status: 'ACTIVE',
        profile_type: 'EMPLOYER',
      });
      (prisma.jobOffer.create as jest.Mock).mockResolvedValue(mockOffer);
    });

    it('creates offer with valid data including quantity', async () => {
      const result = await service.create(EMPLOYER_ID, { ...baseDto });
      expect(result.quantity).toBe(2);
      expect(prisma.jobOffer.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ quantity: 2 }) }),
      );
    });

    it('defaults quantity to 1 when not provided', async () => {
      const dtoWithoutQuantity = { ...baseDto, quantity: undefined as any };
      (prisma.jobOffer.create as jest.Mock).mockResolvedValue({ ...mockOffer, quantity: 1 });
      const result = await service.create(EMPLOYER_ID, dtoWithoutQuantity);
      expect(result.quantity).toBe(1);
    });

    it('throws BadRequestException when quantity < 1', async () => {
      await expect(
        service.create(EMPLOYER_ID, { ...baseDto, quantity: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when quantity > 100', async () => {
      await expect(
        service.create(EMPLOYER_ID, { ...baseDto, quantity: 101 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when employer not found', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.create(EMPLOYER_ID, { ...baseDto })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException when employer is not ACTIVE', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        id: EMPLOYER_ID,
        status: 'SUSPENDED',
        profile_type: 'EMPLOYER',
      });
      await expect(service.create(EMPLOYER_ID, { ...baseDto })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException when profile is not EMPLOYER', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        id: EMPLOYER_ID,
        status: 'ACTIVE',
        profile_type: 'WORKER',
      });
      await expect(service.create(EMPLOYER_ID, { ...baseDto })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException when scheduled_at < 4h from now', async () => {
      const dto = { ...baseDto, scheduled_at: futureDate(1) };
      await expect(service.create(EMPLOYER_ID, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when amount is below minimum', async () => {
      await expect(
        service.create(EMPLOYER_ID, { ...baseDto, amount: 500 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when amount is above maximum', async () => {
      await expect(
        service.create(EMPLOYER_ID, { ...baseDto, amount: 2_000_000 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('findActive()', () => {
    const activeOffers = [
      { ...mockOffer, id: 'offer-1' },
      { ...mockOffer, id: 'offer-2' },
    ];

    it('returns paginated ACTIVE offers', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue(activeOffers);
      const result = await service.findActive(5);
      expect(result.data).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it('returns nextCursor when there are more results', async () => {
      const moreOffers = Array.from({ length: 6 }, (_, i) => ({
        ...mockOffer,
        id: `offer-${i}`,
      }));
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue(moreOffers);
      const result = await service.findActive(5);
      expect(result.data).toHaveLength(5);
      expect(result.nextCursor).toBe('offer-4');
    });

    it('excludes offers already applied by a specific worker', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([]);
      await service.findActive(5, undefined, WORKER_ID);
      expect(prisma.jobOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            applications: { none: { worker_id: WORKER_ID } },
          }),
        }),
      );
    });

    it('uses cursor-based pagination when cursor provided', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([]);
      await service.findActive(5, 'some-cursor');
      expect(prisma.jobOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: { id: 'some-cursor' },
          skip: 1,
        }),
      );
    });
  });

  describe('validateCreateDto()', () => {
    it('throws when title is too short', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, title: 'abc' }),
      ).toThrow(BadRequestException);
    });

    it('throws when title is too long', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, title: 'x'.repeat(101) }),
      ).toThrow(BadRequestException);
    });

    it('throws when description is too short', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, description: 'short' }),
      ).toThrow(BadRequestException);
    });

    it('throws when description is too long', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, description: 'x'.repeat(1001) }),
      ).toThrow(BadRequestException);
    });

    it('throws when scheduled_at is invalid date format', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, scheduled_at: 'not-a-date' }),
      ).toThrow(BadRequestException);
    });

    it('throws when amount is out of bounds', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, amount: 50 }),
      ).toThrow(BadRequestException);
    });

    it('throws when address is too short', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, address: 'short' }),
      ).toThrow(BadRequestException);
    });

    it('throws when quantity is invalid (0)', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, quantity: 0 }),
      ).toThrow(BadRequestException);
    });

    it('throws when quantity is invalid (> 100)', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, quantity: 200 }),
      ).toThrow(BadRequestException);
    });
  });
});
