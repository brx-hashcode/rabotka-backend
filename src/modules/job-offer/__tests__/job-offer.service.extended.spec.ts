import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { JobOfferService } from '../job-offer.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { WalletService } from '../../wallet/wallet.service';
import { BotNotificationService } from '../../bot/services/bot-notification.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JobOfferStatus, PaymentFlow } from '@prisma/client';
import { MatchingService } from '../../matching/matching.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { GeocodingService } from '../../../common/services/geocoding/geocoding.service';

const EMPLOYER_ID = 'employer-uuid-1';
const OFFER_ID = 'offer-uuid-1';
const WORKER_ID = 'worker-uuid-1';

function futureDate(hoursFromNow = 5): string {
  return new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
}

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

describe('JobOfferService (extended)', () => {
  let service: JobOfferService;
  let prisma: jest.Mocked<PrismaService>;
  let mailService: jest.Mocked<MailService>;
  let systemConfigService: jest.Mocked<SystemConfigService>;
  let walletService: jest.Mocked<WalletService>;
  let botNotificationService: jest.Mocked<BotNotificationService>;

  beforeEach(async () => {
    const mockPrisma = {
      profile: { findUnique: jest.fn() },
      jobOffer: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
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
        {
          provide: BotNotificationService,
          useValue: mockBotNotificationService,
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: MatchingService,
          useValue: {
            indexJobOffer: jest.fn().mockResolvedValue(undefined),
            findMatchingWorkersForJob: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: REDIS_CONNECTION,
          useValue: { set: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: GeocodingService,
          useValue: { geocode: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<JobOfferService>(JobOfferService);
    prisma = module.get(PrismaService);
    mailService = module.get(MailService);
    systemConfigService = module.get(SystemConfigService);
    walletService = module.get(WalletService);
    botNotificationService = module.get(BotNotificationService);
  });

  describe('validateCreateDto() — note', () => {
    const baseDto = {
      title: 'Plombier pour urgence',
      description: 'Réparation fuite eau cuisine, remplacement robinet, vérif.',
      scheduled_at: futureDate(5),
      amount: 15000,
      payment_flow: PaymentFlow.DAILY,
      address: '123 Avenue de la Paix, Poto-Poto',
      quantity: 1,
    };

    it('throws BadRequestException when note exceeds 500 chars', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, note: 'x'.repeat(501) }),
      ).toThrow(BadRequestException);
    });

    it('does not throw when note is exactly 500 chars', () => {
      expect(() =>
        service.validateCreateDto({ ...baseDto, note: 'x'.repeat(500) }),
      ).not.toThrow();
    });
  });

  describe('findById()', () => {
    it('returns null when offer not found', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(null);
      expect(await service.findById('non-existent')).toBeNull();
    });

    it('returns offer with employer info', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue({
        ...mockOffer,
        employer: {
          id: EMPLOYER_ID,
          first_name: 'Paul',
          last_name: 'Kanda',
          phone: '06 000',
          reliability_score: 90,
        },
        _count: { applications: 2 },
      });
      const result = await service.findById(OFFER_ID);
      expect(result?.employer?.first_name).toBe('Paul');
      expect(result?.acceptedCount).toBe(2);
    });

    it('returns undefined employer when employer is null', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue({
        ...mockOffer,
        employer: null,
        _count: { applications: 0 },
      });
      const result = await service.findById(OFFER_ID);
      expect(result?.employer).toBeUndefined();
    });
  });

  describe('findByEmployerId()', () => {
    it('returns offers for employer', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([mockOffer]);
      const result = await service.findByEmployerId(EMPLOYER_ID);
      expect(result).toHaveLength(1);
      expect(result[0].employer_id).toBe(EMPLOYER_ID);
    });

    it('returns empty array when no offers', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([]);
      expect(await service.findByEmployerId(EMPLOYER_ID)).toHaveLength(0);
    });
  });

  describe('updateStatus()', () => {
    it('updates status successfully', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(mockOffer);
      (prisma.jobOffer.update as jest.Mock).mockResolvedValue({
        ...mockOffer,
        status: 'CANCELLED',
      });
      const result = await service.updateStatus(
        OFFER_ID,
        JobOfferStatus.CANCELLED,
        EMPLOYER_ID,
      );
      expect(result.status).toBe('CANCELLED');
    });

    it('throws NotFoundException when not found', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.updateStatus(OFFER_ID, JobOfferStatus.CANCELLED, EMPLOYER_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when not owner', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(mockOffer);
      await expect(
        service.updateStatus(OFFER_ID, JobOfferStatus.CANCELLED, 'other-id'),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getJobOffersForAdmin()', () => {
    const adminOffer = {
      ...mockOffer,
      employer: {
        id: EMPLOYER_ID,
        first_name: 'Paul',
        last_name: 'Kanda',
        email: 'paul@test.com',
        phone: '06 000',
        avatar_url: null,
      },
      _count: { applications: 3 },
    };

    it('returns paginated results', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([adminOffer]);
      (prisma.jobOffer.count as jest.Mock).mockResolvedValue(1);
      const result = await service.getJobOffersForAdmin({ page: 1, limit: 10 });
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.data[0].employerName).toBe('Paul Kanda');
    });

    it('applies search query filter', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.jobOffer.count as jest.Mock).mockResolvedValue(0);
      await service.getJobOffersForAdmin({ page: 1, limit: 10, q: 'livreur' });
      expect(prisma.jobOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
        }),
      );
    });

    it('applies status filter', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.jobOffer.count as jest.Mock).mockResolvedValue(0);
      await service.getJobOffersForAdmin({
        page: 1,
        limit: 10,
        status: [JobOfferStatus.ACTIVE],
      });
      expect(prisma.jobOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: [JobOfferStatus.ACTIVE] },
          }),
        }),
      );
    });

    it('returns results without error when called with basic params', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.jobOffer.count as jest.Mock).mockResolvedValue(0);
      const result = await service.getJobOffersForAdmin({
        page: 1,
        limit: 10,
      });
      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('uses "—" when employer name is empty', async () => {
      const noNameOffer = {
        ...adminOffer,
        employer: { ...adminOffer.employer, first_name: null, last_name: null },
      };
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([noNameOffer]);
      (prisma.jobOffer.count as jest.Mock).mockResolvedValue(1);
      const result = await service.getJobOffersForAdmin({ page: 1, limit: 10 });
      expect(result.data[0].employerName).toBe('—');
    });

    it('ignores empty search query', async () => {
      (prisma.jobOffer.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.jobOffer.count as jest.Mock).mockResolvedValue(0);
      await service.getJobOffersForAdmin({ page: 1, limit: 10, q: '  ' });
      expect(prisma.jobOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.not.objectContaining({ OR: expect.any(Array) }),
        }),
      );
    });
  });

  describe('getJobOfferDetailForAdmin()', () => {
    const detailOffer = {
      ...mockOffer,
      employer: {
        id: EMPLOYER_ID,
        first_name: 'Paul',
        last_name: 'Kanda',
        email: 'paul@test.com',
        phone: '06 000',
        avatar_url: 'https://avatar.com/img',
      },
      applications: [
        {
          id: 'app-1',
          worker_id: WORKER_ID,
          status: 'PENDING',
          penalty_applied: false,
          penalty_amount: 5000,
          cancelled_at: new Date(),
          cancellation_reason: 'Empêchement',
          created_at: new Date(),
          worker: {
            id: WORKER_ID,
            first_name: 'Ana',
            last_name: 'Mbo',
            email: 'ana@test.com',
            phone: '07 111',
            avatar_url: null,
          },
        },
      ],
      _count: { applications: 1 },
    };

    it('returns full detail with applications', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(detailOffer);
      const result = await service.getJobOfferDetailForAdmin(OFFER_ID);
      expect(result.applications).toHaveLength(1);
      expect(result.applications[0].workerName).toBe('Ana Mbo');
      expect(result.applications[0].penaltyAmount).toBe(5000);
      expect(result.applications[0].cancellationReason).toBe('Empêchement');
      expect(result.employerAvatarUrl).toBe('https://avatar.com/img');
    });

    it('throws NotFoundException when not found', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.getJobOfferDetailForAdmin('non-existent'),
      ).rejects.toThrow(NotFoundException);
    });

    it('uses "—" when worker has no name', async () => {
      const noNameApp = {
        ...detailOffer,
        applications: [
          {
            ...detailOffer.applications[0],
            worker: {
              ...detailOffer.applications[0].worker,
              first_name: null,
              last_name: null,
            },
          },
        ],
      };
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(noNameApp);
      const result = await service.getJobOfferDetailForAdmin(OFFER_ID);
      expect(result.applications[0].workerName).toBe('—');
    });
  });

  describe('deleteJobOfferByAdmin()', () => {
    it('deletes offer successfully', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue({
        id: OFFER_ID,
      });
      (prisma.jobOffer.delete as jest.Mock).mockResolvedValue(mockOffer);
      await expect(
        service.deleteJobOfferByAdmin(OFFER_ID),
      ).resolves.toBeUndefined();
      expect(prisma.jobOffer.delete).toHaveBeenCalledWith({
        where: { id: OFFER_ID },
      });
    });

    it('throws NotFoundException when not found', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.deleteJobOfferByAdmin('no')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateJobOfferByAdmin()', () => {
    const detailOffer = {
      ...mockOffer,
      employer: {
        id: EMPLOYER_ID,
        first_name: 'Paul',
        last_name: 'Kanda',
        email: 'paul@test.com',
        phone: '06 000',
        avatar_url: null,
      },
      applications: [],
      _count: { applications: 0 },
    };

    it('updates offer with all fields', async () => {
      (prisma.jobOffer.findUnique as jest.Mock)
        .mockResolvedValueOnce({ id: OFFER_ID, status: JobOfferStatus.ACTIVE })
        .mockResolvedValueOnce(detailOffer);
      (prisma.jobOffer.update as jest.Mock).mockResolvedValue(mockOffer);
      const result = await service.updateJobOfferByAdmin(OFFER_ID, {
        title: 'Nouveau titre',
        description: 'Nouvelle description longue pour passer la validation',
        scheduledAt: futureDate(6),
        amount: 20000,
        paymentFlow: PaymentFlow.DAILY,
        address: '456 Boulevard du 30 Juin',
        note: 'Apportez vos outils',
        quantity: 3,
      });
      expect(result.id).toBe(OFFER_ID);
    });

    it('handles empty note (clears to null)', async () => {
      (prisma.jobOffer.findUnique as jest.Mock)
        .mockResolvedValueOnce({ id: OFFER_ID, status: JobOfferStatus.ACTIVE })
        .mockResolvedValueOnce(detailOffer);
      (prisma.jobOffer.update as jest.Mock).mockResolvedValue(mockOffer);
      await service.updateJobOfferByAdmin(OFFER_ID, { note: '' });
      expect(prisma.jobOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ note: null }),
        }),
      );
    });

    it('throws NotFoundException when not found', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.updateJobOfferByAdmin('no', { title: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when offer not ACTIVE', async () => {
      (prisma.jobOffer.findUnique as jest.Mock).mockResolvedValue({
        id: OFFER_ID,
        status: JobOfferStatus.CANCELLED,
      });
      await expect(
        service.updateJobOfferByAdmin(OFFER_ID, { title: 'X' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
