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
import { MailService } from '../../mail/mail.service';
import { PaymentService } from '../../payments/payment.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { PaymentRequestStatus } from '@prisma/client';
import { WalletService } from '../../wallet/wallet.service';
import { MonetbilService } from '../monetbil.service';
import { PaymentStatusGateway } from '../../ws-notifications/payment-status.gateway';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BotNotificationService } from '../../bot/services/bot-notification.service';
import { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import { InvoiceService } from '../../invoice/invoice.service';
import { StorageService } from '../../../common/services/storage/storage.service';

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
        { provide: MailService, useValue: { sendMail: jest.fn().mockResolvedValue(undefined), sendActivationEmail: jest.fn(), sendKycRejectedEmail: jest.fn(), sendKycApprovedEmail: jest.fn() } },
        { provide: PaymentService, useValue: { makePayment: jest.fn().mockResolvedValue({ paymentId: 'pay-1' }) } },
        { provide: SystemConfigService, useValue: { getRaw: jest.fn().mockResolvedValue('5000'), get: jest.fn().mockResolvedValue('') } },
        { provide: WalletService, useValue: { getOrCreateSystemWallet: jest.fn().mockResolvedValue({ id: 'sys-wallet' }), getProfileWalletBalance: jest.fn().mockResolvedValue(0) } },
        { provide: MonetbilService, useValue: { initiatePayment: jest.fn(), verifyWebhookSignature: jest.fn() } },
        { provide: PaymentStatusGateway, useValue: { emitPaymentStatus: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: BotNotificationService, useValue: { sendContactUnlockedNotification: jest.fn().mockResolvedValue(undefined) } },
        { provide: ContactUnlockService, useValue: { payUnlock: jest.fn(), getContactsIfUnlocked: jest.fn() } },
        { provide: InvoiceService, useValue: { create: jest.fn().mockResolvedValue({ id: 'inv-1' }), downloadAsAdmin: jest.fn().mockResolvedValue({ buffer: Buffer.from('pdf'), filename: 'invoice.pdf' }) } },
        { provide: StorageService, useValue: { upload: jest.fn().mockResolvedValue({ url: 'https://cdn.example.com/invoice.pdf' }) } },
      ],
    }).compile();

    service = module.get<PaymentRequestService>(PaymentRequestService);
    prisma = module.get(PrismaService);
    whatsApp = module.get(WhatsAppService);
    log = module.get(LogService);
    configService = module.get(ConfigService);
  });

  describe('createPaymentUrl()', () => {
    it('creates payment request and returns URL', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockProfile);
      (prisma.paymentRequest.create as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING),
      );

      const url = await service.createPaymentUrl(PROFILE_ID, 5000, 'Test payment');

      expect(prisma.paymentRequest.create).toHaveBeenCalled();
      expect(url).toContain('/pay/');
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

  describe('initiateMonetbilPayment()', () => {
    it('throws NotFoundException when token not found', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.initiateMonetbilPayment(TOKEN, '237600000001', 'MTN'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when request is not PENDING', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PROCESSING),
      );

      await expect(
        service.initiateMonetbilPayment(TOKEN, '237600000001', 'MTN'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('handleMonetbilCallback()', () => {
    it('returns early when payment ref not found', async () => {
      (prisma.paymentRequest.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.handleMonetbilCallback({ payment_ref: 'unknown', status: '1', amount: '5000', phone: '237600000001' }),
      ).resolves.not.toThrow();
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
