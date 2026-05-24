import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import { QueueService } from '../../common/services/queue/queue.service';
import {
  WHATSAPP_INBOUND_QUEUE,
  WHATSAPP_OUTBOUND_QUEUE,
} from '../../common/services/queue/queue.module';
import type { WhatsAppOutboundJobData } from './whatsapp-outbound.processor';

export type WhatsAppInboundJobData = {
  phone: string;
  text: string;
  messageSid?: string;
};

/**
 * Runs inside the API process (not the worker) because it depends on
 * ConversationService, which pulls in the full bot graph. The webhook
 * returns immediately by enqueuing; this processor consumes the queue
 * in the same process. Concurrency keeps Twilio webhook latency low.
 */
@Injectable()
export class WhatsAppInboundProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhatsAppInboundProcessor.name);

  constructor(
    private readonly conversationService: ConversationService,
    private readonly queueService: QueueService,
  ) {}

  onApplicationBootstrap(): void {
    this.queueService.createWorker<WhatsAppInboundJobData>(
      WHATSAPP_INBOUND_QUEUE,
      (job) => this.process(job),
      { concurrency: 5 },
    );
    this.logger.log('WhatsApp inbound worker registered (API process)');
  }

  async process(job: {
    id?: string;
    data: WhatsAppInboundJobData;
  }): Promise<void> {
    const { phone, text } = job.data;
    const result = await this.conversationService.handleIncomingMessage(
      phone,
      text,
    );

    for (const message of result.replies) {
      if (!message) continue;
      const outboundJob = parseReplyToJob(phone, result.profileId, message);
      if (outboundJob) {
        await this.queueService.addJob<WhatsAppOutboundJobData>(
          WHATSAPP_OUTBOUND_QUEUE,
          outboundJob,
        );
      }
    }
  }
}

function parseReplyToJob(
  phone: string,
  profileId: string | null,
  message: string,
): WhatsAppOutboundJobData | null {
  const MEDIA_PREFIX = '[IMG:';
  const MEDIA_SUFFIX = ']';

  if (message.startsWith(MEDIA_PREFIX) && message.includes(MEDIA_SUFFIX)) {
    const end = message.indexOf(MEDIA_SUFFIX);
    const mediaUrl = message.slice(MEDIA_PREFIX.length, end).trim();
    const caption = message.slice(end + MEDIA_SUFFIX.length).trim();
    if (!mediaUrl) return null;
    return {
      type: 'media',
      phone,
      profileId: profileId ?? undefined,
      mediaUrl,
      caption: caption || undefined,
    };
  }

  return {
    type: 'text',
    phone,
    profileId: profileId ?? undefined,
    text: message,
  };
}
