import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import type { PaymentJobData } from './payment.service';

@Injectable()
export class PaymentProcessor {
  private readonly logger = new Logger(PaymentProcessor.name);

  constructor(private readonly prisma: PrismaService) {}

  async process(job: { id?: string; data: PaymentJobData }): Promise<void> {
    const { paymentId, type, amount, profileId, entityId } = job.data;
    this.logger.log(
      `Processing payment ${paymentId} — type: ${type}, amount: ${amount}, profileId: ${profileId}${entityId ? `, entityId: ${entityId}` : ''}`,
    );

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.COMPLETED, paid_at: new Date() },
    });

    this.logger.log(`Payment ${paymentId} marked as COMPLETED`);
  }
}
