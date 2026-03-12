import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PaymentRequestService } from '../payment-request.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { LogService } from '../../log/log.service';
import { ConfigService } from '@nestjs/config';
import { PaymentRequestStatus } from '@prisma/client';

const PROFILE_ID = 'profile-uuid-1';
const REQUEST_ID = 'req-uuid-1';
const ADMIN_ID = 'admin-uuid-1';
const TOKEN = 'abc123token';

const mockProfile = {
  id: PROFILE_ID,
  first_name: 'Alice',
  last_name: 'Dupont',
  email: 'alice@example.com',
  phone: '+24200000001',
  status: 'ACTIVE',
  profile_type: 'WORKER',
};

function makeRequest(status: PaymentRequestStatus, overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    profile_id: PROFILE_ID,
    token: TOKEN,
    status,
    payment_reference: null,
    proof_images: [],
    rejection_note: null,
    created_at: new Date(),
    updated_at: new Date(),
    profile: mockProfile,
    ...overrides,
  };
}

describe('PaymentRequestService', () => {
  let service: PaymentRequestService;
  let prisma: jest.Mocked<PrismaService>;
  let whatsApp: jest.Mocked<WhatsAppService>;
  let log: jest.Mocked<LogService>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    const mockPrismaService = {
      profile: { findUnique: jest.fn(), update: jest.fn() },
      paymentRequest: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation((ops: unknown[]) =>
        Promise.resolve(ops.map(() => ({}))),
      ),
    };

    const mockWhatsApp = {
      sendTextMessage: jest.fn().mockResolvedValue(true),
    };

    const mockLog = {
      create: jest.fn().mockResolvedValue({}),
    };

    const mockConfig = {
      get: jest.fn().mockReturnValue('http://localhost:3000'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentRequestService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: WhatsAppService, useValue: mockWhatsApp },
        { provide: LogService, useValue: mockLog },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<PaymentRequestService>(PaymentRequestService);
    prisma = module.get(PrismaService);
    whatsApp = module.get(WhatsAppService);
    log = module.get(LogService);
    configService = module.get(ConfigService);
  });

  describe('createPaymentLink()', () => {
    beforeEach(() => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockProfile);
      (prisma.paymentRequest.create as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING),
      );
    });

    it('creates payment request and sends WhatsApp', async () => {
      const result = await service.createPaymentLink(
        { profileId: PROFILE_ID },
        ADMIN_ID,
      );

      expect(prisma.paymentRequest.create).toHaveBeenCalled();
      expect(whatsApp.sendTextMessage).toHaveBeenCalled();
      expect(log.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYMENT_LINK_CREATED' }),
      );
      expect(result.paymentUrl).toContain('/pay/');
    });

    it('throws NotFoundException when profile not found', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createPaymentLink({ profileId: 'unknown' }, ADMIN_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getByToken()', () => {
    it('returns request info for PENDING request', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING),
      );

      const result = await service.getByToken(TOKEN);

      expect(result.id).toBe(REQUEST_ID);
      expect(result.profileName).toBe('Alice Dupont');
    });

    it('throws NotFoundException when token not found', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getByToken('invalid')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when request is already APPROVED', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.APPROVED),
      );

      await expect(service.getByToken(TOKEN)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when request is already REJECTED', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.REJECTED),
      );

      await expect(service.getByToken(TOKEN)).rejects.toThrow(BadRequestException);
    });
  });

  describe('submitPayment()', () => {
    it('updates status to SUBMITTED', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING),
      );
      (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({});

      const result = await service.submitPayment(TOKEN, {
        paymentReference: 'REF-123',
        proofImages: ['https://img.com/proof.jpg'],
      });

      expect(prisma.paymentRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentRequestStatus.SUBMITTED,
          }),
        }),
      );
      expect(result.message).toBeDefined();
    });

    it('throws NotFoundException when token not found', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.submitPayment('bad-token', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when not PENDING', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.SUBMITTED),
      );

      await expect(service.submitPayment(TOKEN, {})).rejects.toThrow(BadRequestException);
    });
  });

  describe('approve()', () => {
    it('approves request and sends WhatsApp notification', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.SUBMITTED),
      );
      (prisma.$transaction as jest.Mock).mockResolvedValue([
        makeRequest(PaymentRequestStatus.APPROVED),
      ]);

      await service.approve(REQUEST_ID, ADMIN_ID);

      expect(log.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYMENT_APPROVED' }),
      );
      expect(whatsApp.sendTextMessage).toHaveBeenCalled();
    });

    it('throws NotFoundException when request not found', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.approve(REQUEST_ID, ADMIN_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when request is not SUBMITTED', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING),
      );

      await expect(service.approve(REQUEST_ID, ADMIN_ID)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('reject()', () => {
    it('rejects request with note', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.SUBMITTED),
      );
      (prisma.paymentRequest.update as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.REJECTED, { rejection_note: 'Bad proof' }),
      );

      const result = await service.reject(REQUEST_ID, { note: 'Bad proof' }, ADMIN_ID);

      expect(prisma.paymentRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: PaymentRequestStatus.REJECTED,
            rejection_note: 'Bad proof',
          }),
        }),
      );
      expect(log.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYMENT_REJECTED' }),
      );
    });

    it('throws NotFoundException when request not found', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.reject(REQUEST_ID, { note: 'x' }, ADMIN_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when request is not SUBMITTED', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING),
      );

      await expect(
        service.reject(REQUEST_ID, { note: 'x' }, ADMIN_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getList()', () => {
    it('returns paginated list', async () => {
      (prisma.paymentRequest.findMany as jest.Mock).mockResolvedValue([
        makeRequest(PaymentRequestStatus.PENDING),
      ]);
      (prisma.paymentRequest.count as jest.Mock).mockResolvedValue(1);

      const result = await service.getList({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });
});
