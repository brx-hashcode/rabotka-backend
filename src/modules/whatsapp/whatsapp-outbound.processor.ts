import { Injectable, Logger } from '@nestjs/common';
import { MessageDirection } from '@prisma/client';
import { WhatsAppService } from './whatsapp.service';
import { QueueService } from '../../common/services/queue/queue.service';
import {
  WHATSAPP_OUTBOUND_QUEUE,
  WHATSAPP_OUTBOUND_DLQ,
} from '../../common/services/queue/queue.module';

export type WhatsAppOutboundJobData = {
  phone: string;
  profileId?: string;
} & (
  | { type: 'text'; text: string }
  | { type: 'media'; mediaUrl: string; caption?: string }
);

@Injectable()
export class WhatsAppOutboundProcessor {
  private readonly logger = new Logger(WhatsAppOutboundProcessor.name);

  constructor(private readonly whatsApp: WhatsAppService) {
    this.logger.debug(
      `WhatsAppOutboundProcessor constructed, whatsApp=${whatsApp?.constructor?.name ?? typeof whatsApp}`,
    );
  }

  /**
   * Called by worker.ts bootstrap to register the BullMQ worker.
   * Not using onModuleInit to avoid DI ordering issues in the worker context.
   */
  register(queueService: QueueService): void {
    const worker = queueService.createWorker<WhatsAppOutboundJobData>(
      WHATSAPP_OUTBOUND_QUEUE,
      (job) => this.process(job),
      { concurrency: 3 },
    );

    worker.on('failed', (job, err) => {
      if (!job) return;
      const maxAttempts = job.opts?.attempts ?? 3;
      if (job.attemptsMade >= maxAttempts) {
        this.logger.error(
          `Job ${job.id} permanently failed after ${job.attemptsMade} attempts: ${err.message}`,
        );
        queueService
          .addJob(WHATSAPP_OUTBOUND_DLQ, {
            originalJobId: job.id,
            data: job.data,
            error: err.message,
            failedAt: new Date().toISOString(),
          })
          .catch((dlqErr) =>
            this.logger.error(
              `Failed to move job ${job.id} to DLQ`,
              dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
            ),
          );
      }
    });
  }

  async process(job: {
    id?: string;
    data: WhatsAppOutboundJobData;
  }): Promise<void> {
    const { data } = job;
    this.logger.debug(
      `whatsApp instance: ${this.whatsApp?.constructor?.name ?? typeof this.whatsApp}`,
    );

    if (data.type === 'text') {
      const sent = await this.whatsApp.sendTextMessage(
        data.phone,
        data.text,
        data.profileId,
      );
      if (!sent) {
        throw new Error(
          `WhatsApp text message to ${data.phone} returned no SID (unknown Twilio failure)`,
        );
      }
    } else if (data.type === 'media') {
      const sent = await this.whatsApp.sendMediaMessage(
        data.phone,
        data.mediaUrl,
        data.caption,
      );
      if (!sent) {
        throw new Error(
          `WhatsApp media message to ${data.phone} returned no SID (unknown Twilio failure)`,
        );
      }
      if (data.profileId) {
        const body = data.caption
          ? `[IMG:${data.mediaUrl}] ${data.caption}`
          : `[IMG:${data.mediaUrl}]`;
        await this.whatsApp.saveMessage(
          data.profileId,
          MessageDirection.OUTBOUND,
          body,
        );
      }
    }
  }
}
