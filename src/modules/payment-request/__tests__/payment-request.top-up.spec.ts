import { Test, TestingModule } from '@nestjs/testing';
import { PaymentRequestService } from '../payment-request.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { WhatsAppFeedbackService } from '../../whatsapp/feedback/whatsapp-feedback.service';
import { LogService } from '../../log/log.service';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../../mail/mail.service';
import { LayoutService } from '../../mail/layout.service';
import { PaymentService } from '../../payments/payment.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import {
  PaymentRequestStatus,
  PaymentRequestType,
  WalletTransactionType,
  InvoiceReason,
} from '@prisma/client';
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

const PROFILE_ID = 'profile-topup-1';
const REQUEST_ID = 'req-topup-1';
const GATEWAY_REF = 'gw-topup-ref';

const mockProfile = {
  id: PROFILE_ID,
  first_name: 'Bob',
  last_name: 'Martin',
  email: 'bob@example.com',
  phone: '+242061234567',
  status: 'ACTIVE',
  profile_type: 'WORKER',
};

function makeTopUpRequest(
  status: PaymentRequestStatus = PaymentRequestStatus.PROCESSING,
  amount = 5000,
) {
  return {
    id: REQUEST_ID,
    profile_id: PROFILE_ID,
    token: 'top-up-token',
    status,
    payment_reference: null,
    proof_images: [],
    rejection_note: null,
    request_type: PaymentRequestType.WALLET_TOP_UP,
    contact_unlock_attempt_id: null,
    recommendation_worker_id: null,
    gateway: 'MONETBIL',
    gateway_payment_ref: GATEWAY_REF,
    monetbil_payment_ref: GATEWAY_REF,
    operator: 'CG_MTNMOBILEMONEY',
    phone: '+242061234567',
    amount,
    description: `Recharge du wallet — ${amount.toLocaleString('fr-FR')} FCFA`,
    created_at: new Date(),
    updated_at: new Date(),
    profile: mockProfile,
  };
}

describe('PaymentRequestService — WALLET_TOP_UP post-payment', () => {
  let service: PaymentRequestService;
  let mockWalletService: jest.Mocked<
    Pick<
      WalletService,
      | 'getOrCreateSystemWallet'
      | 'getOrCreateMobileMoneyWallet'
      | 'creditProfileWallet'
      | 'getProfileWalletBalance'
    >
  >;
  let mockBotNotification: { sendMessage: jest.Mock; sendContactUnlockedNotification: jest.Mock };
  let mockPrisma: Record<string, unknown>;
  let mockPaymentGateway: { handleWebhookPayload: jest.Mock; initiatePayment: jest.Mock };
  let mockInvoiceService: { create: jest.Mock; downloadAsAdmin: jest.Mock };

  beforeEach(async () => {
    mockInvoiceService = {
      create: jest.fn().mockResolvedValue({ id: 'inv-1' }),
      downloadAsAdmin: jest
        .fn()
        .mockResolvedValue({ buffer: Buffer.from('pdf'), filename: 'invoice.pdf' }),
    };
    mockWalletService = {
      getOrCreateSystemWallet: jest.fn().mockResolvedValue({ id: 'sys-wallet' }),
      getOrCreateMobileMoneyWallet: jest.fn().mockResolvedValue({ id: 'mm-wallet' }),
      creditProfileWallet: jest.fn().mockResolvedValue(undefined),
      getProfileWalletBalance: jest.fn().mockResolvedValue(10000),
    };

    mockBotNotification = {
      sendMessage: jest.fn().mockResolvedValue(undefined),
      sendContactUnlockedNotification: jest.fn().mockResolvedValue(undefined),
    };

    const txMock = {
      paymentRequest: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payment: { create: jest.fn().mockResolvedValue({}) },
      walletTransaction: { create: jest.fn().mockResolvedValue({}) },
      wallet: { update: jest.fn().mockResolvedValue({}) },
    };

    mockPrisma = {
      profile: { findUnique: jest.fn().mockResolvedValue(null) },
      paymentRequest: {
        findFirst: jest.fn().mockResolvedValue(makeTopUpRequest()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: REQUEST_ID }),
      },
      penalty: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn().mockImplementation((cb: unknown) =>
        typeof cb === 'function' ? cb(txMock) : Promise.resolve(true),
      ),
    };

    mockPaymentGateway = {
      handleWebhookPayload: jest.fn().mockResolvedValue({
        gatewayRef: GATEWAY_REF,
        status: 'COMPLETED',
        transactionId: 'tx-123',
      }),
      initiatePayment: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentRequestService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: WhatsAppService,
          useValue: { sendTextMessage: jest.fn().mockResolvedValue(true), sendMediaMessage: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: WhatsAppFeedbackService,
          useValue: { mintFlowToken: jest.fn(() => 'fb_profile-1_uuid') },
        },
        { provide: LogService, useValue: { create: jest.fn().mockResolvedValue({}) } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('http://localhost:3000') } },
        { provide: MailService, useValue: { sendMail: jest.fn().mockResolvedValue(undefined) } },
        { provide: LayoutService, useValue: { wrap: jest.fn().mockImplementation((html: string) => Promise.resolve(html)) } },
        { provide: PaymentService, useValue: { makePayment: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: {
            getRaw: jest.fn().mockResolvedValue('5000'),
            get: jest.fn().mockResolvedValue(''),
            getPaymentGatewayDriver: jest.fn().mockResolvedValue('MONETBIL'),
            getFees: jest.fn().mockResolvedValue({ billingBlockThreshold: 3 }),
          },
        },
        { provide: WalletService, useValue: mockWalletService },
        { provide: MonetbilService, useValue: { initiatePayment: jest.fn(), verifyWebhookSignature: jest.fn() } },
        { provide: PaymentGatewayService, useValue: mockPaymentGateway },
        { provide: PaymentStatusGateway, useValue: { emitPaymentStatus: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: BotNotificationService, useValue: mockBotNotification },
        { provide: ContactUnlockService, useValue: { payUnlock: jest.fn(), getContactsIfUnlocked: jest.fn() } },
        {
          provide: InvoiceService,
          useValue: mockInvoiceService,
        },
        { provide: StorageService, useValue: { upload: jest.fn().mockResolvedValue({ url: 'https://cdn.example.com/invoice.pdf' }) } },
        { provide: QueueService, useValue: { addJob: jest.fn().mockResolvedValue('job-1') } },
      ],
    }).compile();

    service = module.get<PaymentRequestService>(PaymentRequestService);
  });

  it('credits profile wallet with TOP_UP_CREDIT on successful webhook', async () => {
    await service.handlePaymentCallback({ paymentId: GATEWAY_REF, status: 'SUCCESS' });

    expect(mockWalletService.creditProfileWallet).toHaveBeenCalledWith(
      PROFILE_ID,
      5000,
      WalletTransactionType.TOP_UP_CREDIT,
      'payment_request',
      REQUEST_ID,
    );
  });

  it('creates a downloadable WALLET_TOP_UP invoice on successful top-up', async () => {
    await service.handlePaymentCallback({ paymentId: GATEWAY_REF, status: 'SUCCESS' });

    expect(mockInvoiceService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: PROFILE_ID,
        paymentRequestId: REQUEST_ID,
        amount: 5000,
        reason: InvoiceReason.WALLET_TOP_UP,
      }),
    );
  });

  it('fetches new balance and sends WhatsApp confirmation after top-up', async () => {
    await service.handlePaymentCallback({ paymentId: GATEWAY_REF, status: 'SUCCESS' });

    expect(mockWalletService.getProfileWalletBalance).toHaveBeenCalledWith(PROFILE_ID);
    expect(mockBotNotification.sendMessage).toHaveBeenCalledWith(
      mockProfile.phone,
      expect.stringContaining('Wallet rechargé'),
    );
  });

  it('WhatsApp message includes credited amount and new balance', async () => {
    mockWalletService.getProfileWalletBalance.mockResolvedValue(15000);

    await service.handlePaymentCallback({ paymentId: GATEWAY_REF, status: 'SUCCESS' });

    const sentMessage = mockBotNotification.sendMessage.mock.calls[0]?.[1] as string;
    expect(sentMessage).toContain('5');    // credited amount
    expect(sentMessage).toContain('15');   // new balance
  });

  it('does NOT credit wallet for PENALTY_BATCH payment (no regression)', async () => {
    const penaltyRequest = {
      ...makeTopUpRequest(),
      request_type: PaymentRequestType.PENALTY_BATCH,
    };
    (mockPrisma.paymentRequest as Record<string, jest.Mock>).findFirst.mockResolvedValue(penaltyRequest);

    await service.handlePaymentCallback({ paymentId: GATEWAY_REF, status: 'SUCCESS' });

    expect(mockWalletService.creditProfileWallet).not.toHaveBeenCalled();
  });

  it('does NOT credit wallet for CONTACT_UNLOCK payment (no regression)', async () => {
    const contactRequest = {
      ...makeTopUpRequest(),
      request_type: PaymentRequestType.CONTACT_UNLOCK,
      contact_unlock_attempt_id: 'attempt-1',
    };
    (mockPrisma.paymentRequest as Record<string, jest.Mock>).findFirst.mockResolvedValue(contactRequest);

    await service.handlePaymentCallback({ paymentId: GATEWAY_REF, status: 'SUCCESS' });

    expect(mockWalletService.creditProfileWallet).not.toHaveBeenCalled();
  });

  it('is idempotent — duplicate webhook does not double-credit wallet', async () => {
    // First call: $transaction returns count=1 (claimed)
    // Second call: $transaction returns count=0 (already processed)
    (mockPrisma.$transaction as jest.Mock)
      .mockImplementationOnce((cb: unknown) =>
        typeof cb === 'function'
          ? cb({
              paymentRequest: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
              payment: { create: jest.fn().mockResolvedValue({}) },
              walletTransaction: { create: jest.fn().mockResolvedValue({}) },
              wallet: { update: jest.fn().mockResolvedValue({}) },
            })
          : Promise.resolve(true),
      )
      .mockImplementationOnce((cb: unknown) =>
        typeof cb === 'function'
          ? cb({
              paymentRequest: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
              payment: { create: jest.fn().mockResolvedValue({}) },
              walletTransaction: { create: jest.fn().mockResolvedValue({}) },
              wallet: { update: jest.fn().mockResolvedValue({}) },
            })
          : Promise.resolve(false),
      );

    await service.handlePaymentCallback({ paymentId: GATEWAY_REF, status: 'SUCCESS' });
    await service.handlePaymentCallback({ paymentId: GATEWAY_REF, status: 'SUCCESS' });

    // creditProfileWallet should only have been called once
    expect(mockWalletService.creditProfileWallet).toHaveBeenCalledTimes(1);
  });
});
