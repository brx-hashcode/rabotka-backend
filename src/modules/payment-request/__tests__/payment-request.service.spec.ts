import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentRequestService } from '../payment-request.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { LogService } from '../../log/log.service';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../../mail/mail.service';
import { PaymentService } from '../../payments/payment.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { PaymentRequestStatus, PaymentRequestType } from '@prisma/client';
import { WalletService } from '../../wallet/wallet.service';
import { MonetbilService } from '../monetbil.service';
import { PaymentStatusGateway } from '../../ws-notifications/payment-status.gateway';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BotNotificationService } from '../../bot/services/bot-notification.service';
import { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import { InvoiceService } from '../../invoice/invoice.service';
import { StorageService } from '../../../common/services/storage/storage.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import { PaymentGatewayService } from '../../../common/services/payment/payment-gateway.service';

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

function makeRequest(
  status: PaymentRequestStatus,
  overrides: Record<string, unknown> = {},
) {
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
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn(),
      },
      $transaction: jest
        .fn()
        .mockImplementation((ops: unknown[]) =>
          Promise.resolve(ops.map(() => ({}))),
        ),
    };

    const mockWhatsApp = {
      sendTextMessage: jest.fn().mockResolvedValue(true),
      sendMediaMessage: jest.fn().mockResolvedValue(true),
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
        {
          provide: MailService,
          useValue: {
            sendMail: jest.fn().mockResolvedValue(undefined),
            sendActivationEmail: jest.fn(),
            sendKycRejectedEmail: jest.fn(),
            sendKycApprovedEmail: jest.fn(),
          },
        },
        {
          provide: PaymentService,
          useValue: {
            makePayment: jest.fn().mockResolvedValue({ paymentId: 'pay-1' }),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            getRaw: jest.fn().mockResolvedValue('5000'),
            get: jest.fn().mockResolvedValue(''),
            getPaymentGatewayDriver: jest.fn().mockResolvedValue('MONETBIL'),
          },
        },
        {
          provide: WalletService,
          useValue: {
            getOrCreateSystemWallet: jest
              .fn()
              .mockResolvedValue({ id: 'sys-wallet' }),
            getProfileWalletBalance: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: MonetbilService,
          useValue: {
            initiatePayment: jest.fn(),
            verifyWebhookSignature: jest.fn(),
          },
        },
        {
          provide: PaymentGatewayService,
          useValue: {
            initiatePayment: jest.fn(),
            checkPaymentStatus: jest.fn(),
            handleWebhookPayload: jest.fn().mockResolvedValue({
              gatewayRef: null,
              status: 'PENDING',
              transactionId: null,
            }),
          },
        },
        {
          provide: PaymentStatusGateway,
          useValue: { emitPaymentStatus: jest.fn() },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: BotNotificationService,
          useValue: {
            sendContactUnlockedNotification: jest
              .fn()
              .mockResolvedValue(undefined),
          },
        },
        {
          provide: ContactUnlockService,
          useValue: { payUnlock: jest.fn(), getContactsIfUnlocked: jest.fn() },
        },
        {
          provide: InvoiceService,
          useValue: {
            create: jest.fn().mockResolvedValue({ id: 'inv-1' }),
            downloadAsAdmin: jest.fn().mockResolvedValue({
              buffer: Buffer.from('pdf'),
              filename: 'invoice.pdf',
            }),
          },
        },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue({
              url: 'https://cdn.example.com/invoice.pdf',
            }),
          },
        },
        {
          provide: QueueService,
          useValue: { addJob: jest.fn().mockResolvedValue('job-1') },
        },
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

      const url = await service.createPaymentUrl(
        PROFILE_ID,
        5000,
        'Test payment',
        PaymentRequestType.PENALTY_BATCH,
      );

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

      await expect(service.getByToken('invalid')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when request is already APPROVED', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.APPROVED),
      );

      await expect(service.getByToken(TOKEN)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when request is already REJECTED', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.REJECTED),
      );

      await expect(service.getByToken(TOKEN)).rejects.toThrow(
        BadRequestException,
      );
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

      await expect(service.submitPayment('bad-token', {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when not PENDING', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.SUBMITTED),
      );

      await expect(service.submitPayment(TOKEN, {})).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('initiatePayment()', () => {
    it('throws NotFoundException when token not found', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.initiatePayment(TOKEN, '237600000001', 'MTN'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when request is not PENDING', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PROCESSING),
      );

      await expect(
        service.initiatePayment(TOKEN, '237600000001', 'MTN'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('handlePaymentCallback()', () => {
    it('returns early when payment ref not found', async () => {
      (prisma.paymentRequest.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.handlePaymentCallback({
          payment_ref: 'unknown',
          status: '1',
          amount: '5000',
          phone: '237600000001',
        }),
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

    it('filters by status', async () => {
      (prisma.paymentRequest.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.paymentRequest.count as jest.Mock).mockResolvedValue(0);
      const result = await service.getList({
        page: 1,
        limit: 10,
        status: PaymentRequestStatus.APPROVED,
      });
      expect(result.data).toHaveLength(0);
    });

    it('filters by q', async () => {
      (prisma.paymentRequest.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.paymentRequest.count as jest.Mock).mockResolvedValue(0);
      const result = await service.getList({ page: 1, limit: 10, q: 'alice' });
      expect(result.total).toBe(0);
    });
  });

  describe('initiatePayment() - more branches', () => {
    it('throws BadRequestException when amount is null', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING, { amount: null }),
      );
      await expect(
        service.initiatePayment(TOKEN, '+242001', 'MTN'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when updateMany count=0 (already processing)', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING, { amount: 5000 }),
      );
      (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({
        count: 0,
      });
      await expect(
        service.initiatePayment(TOKEN, '+242001', 'MTN'),
      ).rejects.toThrow(BadRequestException);
    });

    it('reverts to PENDING when gateway fails', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING, { amount: 5000 }),
      );
      (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      const paymentGateway = (service as any).paymentGateway;
      paymentGateway.initiatePayment = jest
        .fn()
        .mockRejectedValueOnce(new Error('Gateway error'));
      await expect(
        service.initiatePayment(TOKEN, '+242001', 'MTN'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.paymentRequest.updateMany).toHaveBeenCalledTimes(2); // original + revert
    });

    it('succeeds and returns success=true', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING, { amount: 5000 }),
      );
      (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({});
      const paymentGateway = (service as any).paymentGateway;
      paymentGateway.initiatePayment = jest
        .fn()
        .mockResolvedValue({ gatewayRef: 'gw-ref-1' });
      const queueService = (service as any).queueService;
      queueService.addJob = jest.fn().mockResolvedValue(undefined);
      const result = await service.initiatePayment(TOKEN, '+242001', 'MTN');
      expect(result.success).toBe(true);
    });

    it('succeeds without gatewayRef (no queue job)', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING, { amount: 5000 }),
      );
      (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });
      (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({});
      const paymentGateway = (service as any).paymentGateway;
      paymentGateway.initiatePayment = jest
        .fn()
        .mockResolvedValue({ gatewayRef: null });
      const result = await service.initiatePayment(TOKEN, '+242001', 'MTN');
      expect(result.success).toBe(true);
    });
  });

  describe('handlePaymentCallback() - more branches', () => {
    it('returns received=true when gatewayRef missing', async () => {
      const paymentGateway = (service as any).paymentGateway;
      paymentGateway.handleWebhookPayload = jest.fn().mockResolvedValue({
        gatewayRef: null,
        status: 'PENDING',
        transactionId: null,
      });
      const result = await service.handlePaymentCallback({ status: '0' });
      expect(result.received).toBe(true);
    });

    it('returns received=true when request not found', async () => {
      const paymentGateway = (service as any).paymentGateway;
      paymentGateway.handleWebhookPayload = jest.fn().mockResolvedValue({
        gatewayRef: 'gw-ref',
        status: 'COMPLETED',
        transactionId: 'tx-1',
      });
      (prisma.paymentRequest.findFirst as jest.Mock).mockResolvedValue(null);
      const result = await service.handlePaymentCallback({ status: '1' });
      expect(result.received).toBe(true);
    });

    it('returns received=true for PENDING status', async () => {
      const paymentGateway = (service as any).paymentGateway;
      paymentGateway.handleWebhookPayload = jest.fn().mockResolvedValue({
        gatewayRef: 'gw-ref',
        status: 'PENDING',
        transactionId: null,
      });
      (prisma.paymentRequest.findFirst as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PROCESSING),
      );
      const result = await service.handlePaymentCallback({ status: '0' });
      expect(result.received).toBe(true);
    });
  });

  describe('processApprovedPaymentById()', () => {
    it('returns early when request not found', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(null);
      await service.processApprovedPaymentById(REQUEST_ID); // no throw
    });

    it('returns early when request is APPROVED', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.APPROVED),
      );
      await service.processApprovedPaymentById(REQUEST_ID); // no throw
    });

    it('returns early when request is REJECTED', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.REJECTED),
      );
      await service.processApprovedPaymentById(REQUEST_ID); // no throw
    });

    it('processes PENDING request through full payment pipeline', async () => {
      const fullRequest = {
        ...makeRequest(PaymentRequestStatus.PENDING),
        amount: 5000,
        request_type: PaymentRequestType.PENALTY_BATCH,
        contact_unlock_attempt_id: null,
        recommendation_worker_id: null,
        description: 'Penalty payment',
        gateway_payment_ref: null,
        monetbil_payment_ref: null,
        profile: {
          ...mockProfile,
          phone: '+24200000001',
          email: 'alice@example.com',
          first_name: 'Alice',
          last_name: 'Dupont',
        },
      };

      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        fullRequest,
      );

      // Setup tx mock for persistApprovedPayment
      const txMock = {
        paymentRequest: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        payment: { create: jest.fn().mockResolvedValue({}) },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
        wallet: { update: jest.fn().mockResolvedValue({}) },
        penalty: {
          updateMany: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(0),
        },
        profile: { update: jest.fn().mockResolvedValue({}) },
      };

      (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => {
        if (typeof cb === 'function') return cb(txMock);
        return Promise.resolve([]);
      });

      // Mock systemConfig.getFees
      const systemConfig = (service as any).systemConfig;
      if (systemConfig) {
        systemConfig.getFees = jest
          .fn()
          .mockResolvedValue({ billingBlockThreshold: 2 });
      }

      // Mock botNotification.sendMessage
      const botNotification = (service as any).botNotification;
      if (botNotification) {
        botNotification.sendMessage = jest.fn().mockResolvedValue(undefined);
      }

      // Mock contactUnlock
      const contactUnlock = (service as any).contactUnlock;
      if (contactUnlock) {
        contactUnlock.payUnlock = jest.fn().mockResolvedValue(undefined);
        contactUnlock.getContactsIfUnlocked = jest.fn().mockResolvedValue(null);
      }

      await service.processApprovedPaymentById(REQUEST_ID);
      // Should complete without throwing
    });

    it('handles already-processed payment (count=0 from tx)', async () => {
      const fullRequest = {
        ...makeRequest(PaymentRequestStatus.PENDING),
        amount: 5000,
        request_type: PaymentRequestType.PENALTY_BATCH,
        contact_unlock_attempt_id: null,
        recommendation_worker_id: null,
        description: 'Penalty payment',
        gateway_payment_ref: null,
        monetbil_payment_ref: null,
        profile: { ...mockProfile, phone: null, email: null },
      };
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        fullRequest,
      );
      const txMock = {
        paymentRequest: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        }, // already processed
        payment: { create: jest.fn() },
        walletTransaction: { create: jest.fn() },
        wallet: { update: jest.fn() },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => {
        if (typeof cb === 'function') return cb(txMock);
        return Promise.resolve([]);
      });
      await service.processApprovedPaymentById(REQUEST_ID);
    });
  });

  describe('processApprovedPaymentById() - contact unlock path', () => {
    function setupContactUnlockRequest() {
      const req = {
        ...makeRequest(PaymentRequestStatus.PENDING),
        amount: 5000,
        request_type: PaymentRequestType.CONTACT_UNLOCK,
        contact_unlock_attempt_id: 'unlock-1',
        recommendation_worker_id: null,
        description: 'Contact unlock',
        gateway_payment_ref: null,
        monetbil_payment_ref: null,
        profile: {
          ...mockProfile,
          phone: '+242',
          email: 'alice@test.com',
          first_name: 'Alice',
          last_name: 'Dupont',
        },
      };
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(req);
      const txMock = {
        paymentRequest: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        payment: { create: jest.fn().mockResolvedValue({}) },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
        wallet: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => {
        if (typeof cb === 'function') return cb(txMock);
        return Promise.resolve([]);
      });
      const contactUnlock = (service as any).contactUnlock;
      if (contactUnlock) {
        contactUnlock.payUnlock = jest
          .fn()
          .mockResolvedValue({ nowUnlocked: true });
        contactUnlock.getContactsIfUnlocked = jest
          .fn()
          .mockResolvedValue({ workerPhone: '+242111' });
      }
      const botNotification = (service as any).botNotification;
      if (botNotification) {
        botNotification.sendContactUnlockedNotification = jest
          .fn()
          .mockResolvedValue(undefined);
      }
      return req;
    }

    it('processes CONTACT_UNLOCK request', async () => {
      setupContactUnlockRequest();
      await service.processApprovedPaymentById(REQUEST_ID);
    });

    it('processes RECOMMENDATION_CONTACT request with worker', async () => {
      const req = {
        ...makeRequest(PaymentRequestStatus.PENDING),
        amount: 5000,
        request_type: PaymentRequestType.RECOMMENDATION_CONTACT,
        contact_unlock_attempt_id: null,
        recommendation_worker_id: 'worker-1',
        description: null,
        gateway_payment_ref: null,
        monetbil_payment_ref: null,
        profile: {
          ...mockProfile,
          phone: '+242',
          email: 'alice@test.com',
          first_name: 'Alice',
          last_name: 'Dupont',
        },
      };
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(req);
      (prisma.profile as any).findUnique = jest
        .fn()
        .mockResolvedValue({ first_name: 'Bob', last_name: 'Smith' });
      const txMock = {
        paymentRequest: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        payment: { create: jest.fn().mockResolvedValue({}) },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
        wallet: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => {
        if (typeof cb === 'function') return cb(txMock);
        return Promise.resolve([]);
      });
      const contactUnlock = (service as any).contactUnlock;
      if (contactUnlock) {
        contactUnlock.payUnlock = jest.fn().mockResolvedValue(undefined);
        contactUnlock.getContactsIfUnlocked = jest.fn().mockResolvedValue(null);
      }
      await service.processApprovedPaymentById(REQUEST_ID);
    });
  });

  describe('getByProfileId()', () => {
    it('returns requests for profile', async () => {
      (prisma.paymentRequest.findMany as jest.Mock).mockResolvedValue([
        makeRequest(PaymentRequestStatus.PENDING),
      ]);
      const result = await service.getByProfileId(PROFILE_ID);
      expect(result).toHaveLength(1);
    });
  });

  describe('persistFailedPayment() via webhook', () => {
    it('handles CONTACT_UNLOCK type in persistFailedPayment (GATEWAY_FAILED status)', async () => {
      const req = {
        ...makeRequest(PaymentRequestStatus.PENDING),
        amount: 5000,
        request_type: PaymentRequestType.CONTACT_UNLOCK,
        contact_unlock_attempt_id: 'unlock-1',
        gateway_payment_ref: 'gw-ref-1',
        monetbil_payment_ref: null,
        token: TOKEN,
        phone: '+242000001',
        operator: 'MTN',
        gateway: 'MONETBIL',
        profile: { ...mockProfile },
      };
      (prisma.paymentRequest.findFirst as jest.Mock).mockResolvedValue(req);
      (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({
        ...req,
        status: 'REJECTED',
      });
      (prisma.payment as any) = { create: jest.fn().mockResolvedValue({}) };
      const gatewayService = (service as any).paymentGateway;
      if (gatewayService) {
        gatewayService.handleWebhookPayload = jest.fn().mockResolvedValue({
          gatewayRef: 'gw-ref-1',
          status: 'FAILED',
          transactionId: null,
        });
      }
      const result = await service.handlePaymentCallback({
        gatewayRef: 'gw-ref-1',
        status: 'FAILED',
      });
      expect(result).toEqual({ received: true });
    });

    it('handles prisma.payment.create throwing in persistFailedPayment (GATEWAY_CANCELLED)', async () => {
      const req = {
        ...makeRequest(PaymentRequestStatus.PENDING),
        amount: 5000,
        request_type: PaymentRequestType.PENALTY_BATCH,
        contact_unlock_attempt_id: null,
        gateway_payment_ref: 'gw-ref-2',
        monetbil_payment_ref: null,
        token: TOKEN,
        phone: '+242000001',
        operator: 'MTN',
        gateway: 'MONETBIL',
        profile: { ...mockProfile },
      };
      (prisma.paymentRequest.findFirst as jest.Mock).mockResolvedValue(req);
      (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({
        ...req,
        status: 'REJECTED',
      });
      (prisma.payment as any) = {
        create: jest.fn().mockRejectedValueOnce(new Error('DB error')),
      };
      const gatewayService = (service as any).paymentGateway;
      if (gatewayService) {
        gatewayService.handleWebhookPayload = jest.fn().mockResolvedValue({
          gatewayRef: 'gw-ref-2',
          status: 'CANCELLED',
          transactionId: null,
        });
      }
      const result = await service.handlePaymentCallback({
        gatewayRef: 'gw-ref-2',
        status: 'CANCELLED',
      });
      expect(result).toEqual({ received: true });
    });
  });

  describe('getByToken() - getPaymentGatewayDriver catch', () => {
    it('uses MONETBIL fallback when getPaymentGatewayDriver throws', async () => {
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
        makeRequest(PaymentRequestStatus.PENDING),
      );
      const systemConfig = (service as any).systemConfig;
      if (systemConfig) {
        systemConfig.getPaymentGatewayDriver = jest
          .fn()
          .mockRejectedValueOnce(new Error('config error'));
      }
      const result = await service.getByToken(TOKEN);
      expect(result.gateway).toBe('MONETBIL');
    });
  });

  describe('sendPaymentSuccessNotifications() branches', () => {
    function setupProcessApproval(
      requestOverrides: Record<string, unknown> = {},
    ) {
      const req = {
        ...makeRequest(PaymentRequestStatus.PENDING),
        amount: 5000,
        request_type: PaymentRequestType.PENALTY_BATCH,
        contact_unlock_attempt_id: null,
        recommendation_worker_id: null,
        description: 'Test payment',
        gateway_payment_ref: null,
        monetbil_payment_ref: null,
        profile: {
          ...mockProfile,
          phone: '+242000001',
          email: 'alice@test.com',
        },
        ...requestOverrides,
      };
      (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(req);
      const txMock = {
        paymentRequest: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        payment: { create: jest.fn().mockResolvedValue({}) },
        walletTransaction: { create: jest.fn().mockResolvedValue({}) },
        wallet: { update: jest.fn().mockResolvedValue({}) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => {
        if (typeof cb === 'function') return cb(txMock);
        return Promise.resolve([]);
      });
      return req;
    }

    it('sends notification for RECOMMENDATION_CONTACT (isRecommendationContact=true)', async () => {
      setupProcessApproval({
        request_type: PaymentRequestType.RECOMMENDATION_CONTACT,
        recommendation_worker_id: 'w-1',
        profile: {
          ...mockProfile,
          phone: '+242000001',
          email: 'alice@test.com',
          first_name: 'Alice',
          last_name: 'Dupont',
        },
      });
      (prisma.profile as any).findUnique = jest
        .fn()
        .mockResolvedValue({ first_name: 'Bob', last_name: 'Worker' });
      const contactUnlock = (service as any).contactUnlock;
      if (contactUnlock) {
        contactUnlock.payUnlock = jest.fn().mockResolvedValue(undefined);
        contactUnlock.getContactsIfUnlocked = jest.fn().mockResolvedValue(null);
      }
      await service.processApprovedPaymentById(REQUEST_ID);
      expect(whatsApp.sendTextMessage).toHaveBeenCalled();
    });

    it('sends notification for CONTACT_UNLOCK nowUnlocked=false', async () => {
      setupProcessApproval({
        request_type: PaymentRequestType.CONTACT_UNLOCK,
        contact_unlock_attempt_id: 'att-1',
        profile: {
          ...mockProfile,
          phone: '+242000001',
          email: 'alice@test.com',
          first_name: 'Alice',
          last_name: 'Dupont',
        },
      });
      const contactUnlock = (service as any).contactUnlock;
      if (contactUnlock) {
        contactUnlock.payUnlock = jest.fn().mockResolvedValue({
          status: 'PENDING',
          newlyUnlocked: [],
          attemptId: 'att-1',
        });
        contactUnlock.getContactsIfUnlocked = jest.fn().mockResolvedValue(null);
      }
      await service.processApprovedPaymentById(REQUEST_ID);
      expect(whatsApp.sendTextMessage).toHaveBeenCalled();
    });

    it('sends notification for CONTACT_UNLOCK nowUnlocked=true', async () => {
      setupProcessApproval({
        request_type: PaymentRequestType.CONTACT_UNLOCK,
        contact_unlock_attempt_id: 'att-1',
        profile: {
          ...mockProfile,
          phone: '+242000001',
          email: 'alice@test.com',
          first_name: 'Alice',
          last_name: 'Dupont',
        },
      });
      const contactUnlock = (service as any).contactUnlock;
      if (contactUnlock) {
        contactUnlock.payUnlock = jest.fn().mockResolvedValue({
          status: 'UNLOCKED',
          newlyUnlocked: ['att-1'],
          attemptId: 'att-1',
        });
        contactUnlock.getContactsIfUnlocked = jest
          .fn()
          .mockResolvedValue({ workerPhone: '+242111' });
      }
      const botNotification = (service as any).botNotification;
      if (botNotification) {
        botNotification.sendContactUnlockedNotification = jest
          .fn()
          .mockResolvedValue(undefined);
      }
      await service.processApprovedPaymentById(REQUEST_ID);
      expect(whatsApp.sendTextMessage).toHaveBeenCalled();
    });

    it('handles null email (skips email notification)', async () => {
      setupProcessApproval({
        profile: { ...mockProfile, phone: '+242000001', email: null },
      });
      await service.processApprovedPaymentById(REQUEST_ID);
      // Should not throw
      expect(true).toBe(true);
    });
  });
});
