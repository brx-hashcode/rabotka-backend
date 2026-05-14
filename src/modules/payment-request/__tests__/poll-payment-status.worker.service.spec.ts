import { Test, TestingModule } from '@nestjs/testing';
import { PollPaymentStatusWorkerService } from '../poll-payment-status.worker.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import { PollPaymentStatusProcessor } from '../poll-payment-status.processor';
import { PaymentRequestService } from '../payment-request.service';

const mockQueueService = {
  createWorker: jest.fn(),
};

const mockProcessor = {
  setPaymentRequestService: jest.fn(),
  process: jest.fn(),
};

const mockPaymentRequestService = {};

describe('PollPaymentStatusWorkerService', () => {
  let service: PollPaymentStatusWorkerService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PollPaymentStatusWorkerService,
        { provide: QueueService, useValue: mockQueueService },
        { provide: PollPaymentStatusProcessor, useValue: mockProcessor },
        { provide: PaymentRequestService, useValue: mockPaymentRequestService },
      ],
    }).compile();
    service = module.get<PollPaymentStatusWorkerService>(PollPaymentStatusWorkerService);
  });

  it('onModuleInit sets payment request service and creates worker', () => {
    service.onModuleInit();
    expect(mockProcessor.setPaymentRequestService).toHaveBeenCalledWith(mockPaymentRequestService);
    expect(mockQueueService.createWorker).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ concurrency: 10 }),
    );
  });
});
