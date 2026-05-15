import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QueueService } from '../../common/services/queue/queue.service';
import { POLL_PAYMENT_STATUS_QUEUE } from '../../common/services/queue/queue.module';
import {
  PollPaymentStatusProcessor,
  PollPaymentStatusJobData,
} from './poll-payment-status.processor';
import { PaymentRequestService } from './payment-request.service';

@Injectable()
export class PollPaymentStatusWorkerService implements OnModuleInit {
  private readonly logger = new Logger(PollPaymentStatusWorkerService.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly processor: PollPaymentStatusProcessor,
    private readonly paymentRequestService: PaymentRequestService,
  ) {}

  onModuleInit(): void {
    this.processor.setPaymentRequestService(this.paymentRequestService);
    this.queueService.createWorker<PollPaymentStatusJobData>(
      POLL_PAYMENT_STATUS_QUEUE,
      (job) => this.processor.process(job),
      { concurrency: 10 },
    );
    this.logger.log('Poll-payment-status worker registered');
  }
}
