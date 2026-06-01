import { Injectable, Logger } from '@nestjs/common';
import { MessageDirection } from '@prisma/client';
import { WhatsAppService } from './whatsapp.service';
import { QueueService } from '../../common/services/queue/queue.service';
import {
  WHATSAPP_OUTBOUND_QUEUE,
  WHATSAPP_OUTBOUND_DLQ,
} from '../../common/services/queue/queue.module';

// Twilio's hard limit on a WhatsApp body is 1600 chars. We chunk well below
// that to leave room for any "(1/N)" prefix and to stay safe across UCS-2
// counting edge cases.
const WHATSAPP_BODY_LIMIT = 1500;

/**
 * Split a long string into ≤ WHATSAPP_BODY_LIMIT chunks, preferring to break
 * on blank lines, then single newlines, then spaces. Never breaks inside a
 * word unless a single word exceeds the limit (very rare).
 */
function chunkForWhatsApp(text: string): string[] {
  if (text.length <= WHATSAPP_BODY_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > WHATSAPP_BODY_LIMIT) {
    const slice = remaining.slice(0, WHATSAPP_BODY_LIMIT);
    let cut = slice.lastIndexOf('\n\n');
    if (cut < WHATSAPP_BODY_LIMIT * 0.5) cut = slice.lastIndexOf('\n');
    if (cut < WHATSAPP_BODY_LIMIT * 0.5) cut = slice.lastIndexOf(' ');
    if (cut <= 0) cut = WHATSAPP_BODY_LIMIT;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  // Prefix each with (i/N) so the reader sees ordering.
  return chunks.map((c, i) => `(${i + 1}/${chunks.length})\n${c}`);
}

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
      // Split any over-long body so we never hit Twilio's 1600-char hard
      // limit. For normal-sized messages this is a no-op.
      const parts = chunkForWhatsApp(data.text);
      for (const part of parts) {
        const sent = await this.whatsApp.sendTextMessage(
          data.phone,
          part,
          data.profileId,
        );
        if (!sent) {
          throw new Error(
            `WhatsApp text message to ${data.phone} returned no SID (unknown Twilio failure)`,
          );
        }
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
