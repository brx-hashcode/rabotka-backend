import { Test, TestingModule } from '@nestjs/testing';
import { PollPaymentStatusProcessor } from '../poll-payment-status.processor';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { PaymentGatewayService } from '../../../common/services/payment/payment-gateway.service';
import { PaymentStatusGateway } from '../../ws-notifications/payment-status.gateway';
import { QueueService } from '../../../common/services/queue/queue.service';
import { LogService } from '../../log/log.service';

const mockPrisma = {
  paymentRequest: {
    update: jest.fn().mockResolvedValue({}),
  },
  payment: {
    create: jest.fn().mockResolvedValue({}),
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

const mockPaymentRequestService = {
  processApprovedPaymentById: jest.fn().mockResolvedValue(undefined),
};

const baseJobData = {
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
  requestType: 'CONTACT_UNLOCK',
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
