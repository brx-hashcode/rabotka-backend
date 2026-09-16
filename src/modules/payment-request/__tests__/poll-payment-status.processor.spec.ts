import { Test, TestingModule } from '@nestjs/testing';
import { PaymentRequestType, PaymentStatus, PaymentType } from '@prisma/client';
import {
  PollPaymentStatusProcessor,
  type PollPaymentStatusJobData,
} from '../poll-payment-status.processor';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { PaymentGatewayService } from '../../../common/services/payment/payment-gateway.service';
import { PaymentStatusGateway } from '../../ws-notifications/payment-status.gateway';
import { QueueService } from '../../../common/services/queue/queue.service';
import { LogService } from '../../log/log.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { inAppNotifications } from '../../profile-notification/__tests__/in-app-notifications';

const mockPrisma = {
  paymentRequest: {
    update: jest.fn().mockResolvedValue({}),
  },
  payment: {
    create: jest.fn().mockResolvedValue({}),
  },
  profile: {
    findUnique: jest.fn().mockResolvedValue({ phone: '+242001' }),
  },
};

const mockPaymentGateway = {
  checkPaymentStatus: jest.fn(),
};

const mockPaymentStatusGateway = {
  emitPaymentStatus: jest.fn(),
};

const mockQueueService = {
  addJob: jest.fn().mockResolvedValue(undefined),
};

const mockLogService = {
  create: jest.fn().mockResolvedValue({}),
};

const mockWhatsApp = {
  sendTextMessage: jest.fn().mockResolvedValue(undefined),
};

const mockEvents = { emit: jest.fn() };

const mockPaymentRequestService = {
  processApprovedPaymentById: jest.fn().mockResolvedValue(undefined),
};

const baseJobData: PollPaymentStatusJobData = {
  requestId: 'req-1',
  token: 'tok-1',
  gatewayRef: 'gw-1',
  attempt: 1,
  maxAttempts: 3,
  intervalMs: 5000,
  profileId: 'profile-1',
  amount: 5000,
  phone: '+242001',
  operator: 'MTN',
  requestType: PaymentRequestType.CONTACT_UNLOCK,
  gateway: 'MONETBIL',
};

describe('PollPaymentStatusProcessor', () => {
  let processor: PollPaymentStatusProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PollPaymentStatusProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PaymentGatewayService, useValue: mockPaymentGateway },
        { provide: PaymentStatusGateway, useValue: mockPaymentStatusGateway },
        { provide: QueueService, useValue: mockQueueService },
        { provide: LogService, useValue: mockLogService },
        { provide: WhatsAppService, useValue: mockWhatsApp },
        { provide: EventEmitter2, useValue: mockEvents },
      ],
    }).compile();
    processor = module.get<PollPaymentStatusProcessor>(
      PollPaymentStatusProcessor,
    );
    processor.setPaymentRequestService(mockPaymentRequestService);
  });

  it('setPaymentRequestService sets the service', () => {
    processor.setPaymentRequestService(mockPaymentRequestService);
    expect((processor as any).paymentRequestService).toBe(
      mockPaymentRequestService,
    );
  });

  it('processes COMPLETED payment', async () => {
    mockPaymentGateway.checkPaymentStatus.mockResolvedValueOnce({
      status: 'COMPLETED',
      transactionId: 'tx-1',
    });
    await processor.process({ data: baseJobData });
    expect(
      mockPaymentRequestService.processApprovedPaymentById,
    ).toHaveBeenCalledWith('req-1', 'tx-1');
    expect(mockPaymentStatusGateway.emitPaymentStatus).toHaveBeenCalledWith(
      'tok-1',
      'APPROVED',
    );
  });

  it('processes FAILED payment', async () => {
    mockPaymentGateway.checkPaymentStatus.mockResolvedValueOnce({
      status: 'FAILED',
      transactionId: 'tx-1',
    });
    await processor.process({ data: baseJobData });
    expect(mockPrisma.paymentRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'req-1' } }),
    );
    expect(mockPaymentStatusGateway.emitPaymentStatus).toHaveBeenCalledWith(
      'tok-1',
      'REJECTED',
    );
  });

  it('puts a failure in the payer’s bell, deduplicated with the webhook', async () => {
    mockPaymentGateway.checkPaymentStatus.mockResolvedValueOnce({
      status: 'FAILED',
    });
    await processor.process({ data: baseJobData });

    const [payload] = inAppNotifications(mockEvents.emit, 'PAYMENT_FAILED');
    expect(payload).toMatchObject({
      recipientId: 'profile-1',
      input: { amount: 5000, kind: 'CONTACT_UNLOCK' },
    });
    expect(payload.dedupeKey).toMatch(/payfail:req-1$/);
  });

  it('does not report a timeout as a failure in the bell', async () => {
    mockPaymentGateway.checkPaymentStatus.mockResolvedValueOnce({
      status: 'PENDING',
    });
    await processor.process({
      data: { ...baseJobData, attempt: 3, maxAttempts: 3 },
    });

    expect(inAppNotifications(mockEvents.emit, 'PAYMENT_FAILED')).toHaveLength(
      0,
    );
  });

  it('processes CANCELLED payment', async () => {
    mockPaymentGateway.checkPaymentStatus.mockResolvedValueOnce({
      status: 'CANCELLED',
    });
    await processor.process({ data: baseJobData });
    expect(mockPaymentStatusGateway.emitPaymentStatus).toHaveBeenCalledWith(
      'tok-1',
      'REJECTED',
    );
  });

  it('re-enqueues when still PENDING and not at max attempts', async () => {
    mockPaymentGateway.checkPaymentStatus.mockResolvedValueOnce({
      status: 'PENDING',
    });
    await processor.process({
      data: { ...baseJobData, attempt: 1, maxAttempts: 3 },
    });
    expect(mockQueueService.addJob).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ attempt: 2 }),
      expect.objectContaining({ delay: 5000 }),
    );
  });

  it('times out and reverts to PENDING when max attempts reached', async () => {
    mockPaymentGateway.checkPaymentStatus.mockResolvedValueOnce({
      status: 'PENDING',
    });
    await processor.process({
      data: { ...baseJobData, attempt: 3, maxAttempts: 3 },
    });
    expect(mockPrisma.paymentRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PENDING' } }),
    );
    expect(mockPaymentStatusGateway.emitPaymentStatus).toHaveBeenCalledWith(
      'tok-1',
      'TIMEOUT',
    );
  });

  /**
   * The bug this file did not catch.
   *
   * `recordFailure` open-coded `isContactType ? CONTACT_UNLOCK : PENALTY`, so a
   * wallet recharge that failed at the gateway was written as a PENALTY — and
   * shown to admins as an orange "Penalty" badge against a customer who had
   * only tried to add credit. The mapping now comes from `resolvePaymentType`,
   * which both failure paths share.
   */
  it.each([
    [PaymentRequestType.WALLET_TOP_UP, PaymentType.WALLET_TOP_UP],
    [PaymentRequestType.CONTACT_UNLOCK, PaymentType.CONTACT_UNLOCK],
    [PaymentRequestType.RECOMMENDATION_CONTACT, PaymentType.CONTACT_UNLOCK],
    [PaymentRequestType.PENALTY_BATCH, PaymentType.PENALTY],
    [PaymentRequestType.PENALTY_RESOLUTION, PaymentType.PENALTY],
  ])('records a failed %s as a %s payment', async (requestType, expected) => {
    mockPaymentGateway.checkPaymentStatus.mockResolvedValueOnce({
      status: 'FAILED',
    });

    await processor.process({ data: { ...baseJobData, requestType } });

    expect(mockPrisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: expected,
          status: PaymentStatus.FAILED,
        }),
      }),
    );
  });

  it('still records a penalty when the job carries no request type', async () => {
    // Jobs queued before `requestType` existed deserialise without it, and a
    // FAILED row with a stale type beats no row at all.
    mockPaymentGateway.checkPaymentStatus.mockResolvedValueOnce({
      status: 'FAILED',
    });
    const { requestType: _omitted, ...withoutType } = baseJobData;

    await processor.process({ data: withoutType });

    expect(mockPrisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: PaymentType.PENALTY }),
      }),
    );
  });

  it('handles payment create failure gracefully during recordFailure', async () => {
    mockPaymentGateway.checkPaymentStatus.mockResolvedValueOnce({
      status: 'FAILED',
    });
    mockPrisma.payment.create.mockRejectedValueOnce(new Error('DB error'));
    await expect(
      processor.process({ data: baseJobData }),
    ).resolves.not.toThrow();
  });
});
