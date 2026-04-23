import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JobOfferService } from '../job-offer.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { WalletService } from '../../wallet/wallet.service';
import { BotNotificationService } from '../../bot/services/bot-notification.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JobOfferStatus, PaymentFlow } from '@prisma/client';
import { MatchingService } from '../../matching/matching.service';

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
  let mailService: jest.Mocked<MailService>;
  let systemConfigService: jest.Mocked<SystemConfigService>;
  let walletService: jest.Mocked<WalletService>;
  let botNotificationService: jest.Mocked<BotNotificationService>;

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

    const mockMailService = {
      sendMail: jest.fn().mockResolvedValue(undefined),
    };

    const mockSystemConfigService = {
      getRaw: jest.fn().mockResolvedValue('0'),
    };

    const mockWalletService = {
      recordJobPostingPayment: jest.fn().mockResolvedValue(undefined),
    };

    const mockBotNotificationService = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobOfferService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MailService, useValue: mockMailService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
        { provide: WalletService, useValue: mockWalletService },
        { provide: BotNotificationService, useValue: mockBotNotificationService },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: MatchingService, useValue: { indexJobOffer: jest.fn().mockResolvedValue(undefined), findMatchingWorkersForJob: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();

    service = module.get<JobOfferService>(JobOfferService);
    prisma = module.get(PrismaService);
    mailService = module.get(MailService);
    systemConfigService = module.get(SystemConfigService);
    walletService = module.get(WalletService);
    botNotificationService = module.get(BotNotificationService);
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

    it('omits offers with no open slots (accepted >= quantity)', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([
        { ...mockOffer, id: 'offer-full', quantity: 1, _count: { applications: 1 } },
        { ...mockOffer, id: 'offer-open', quantity: 2, _count: { applications: 0 } },
      ]);
      const result = await service.findActive(5);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.id).toBe('offer-open');
      expect(result.nextCursor).toBeNull();
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
