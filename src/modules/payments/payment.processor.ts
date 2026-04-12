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

    if (!paymentId || !type || !profileId) {
      throw new Error(
        `Invalid payment job data: missing required fields (paymentId=${paymentId}, type=${type}, profileId=${profileId})`,
      );
    }

    const entitySuffix = entityId ? `, entityId: ${entityId}` : '';
    this.logger.log(
      `Processing payment ${paymentId} — type: ${type}, amount: ${amount}, profileId: ${profileId}${entitySuffix}`,
    );

    const existing = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { id: true, status: true },
    });

    if (!existing) {
      throw new Error(`Payment ${paymentId} not found — cannot complete`);
    }

    if (existing.status === PaymentStatus.COMPLETED) {
      this.logger.warn(`Payment ${paymentId} already COMPLETED — skipping`);
      return;
    }

    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.COMPLETED, paid_at: new Date() },
    });

    this.logger.log(`Payment ${paymentId} marked as COMPLETED`);
  }
}
