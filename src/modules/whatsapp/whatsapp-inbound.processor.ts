import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import { QueueService } from '../../common/services/queue/queue.service';
import {
  WHATSAPP_INBOUND_QUEUE,
  WHATSAPP_OUTBOUND_QUEUE,
} from '../../common/services/queue/queue.module';
import type {
  WhatsAppOutboundJobData,
  WhatsAppSend,
} from './whatsapp-outbound.processor';
import { SendTimingService } from './telemetry/send-timing.service';

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
    private readonly sendTiming: SendTimingService,
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

    const jobs: WhatsAppOutboundJobData[] = [];
    for (const message of result.replies) {
      if (!message) continue;
      const outboundJob = parseReplyToJob(phone, result.profileId, message);
      if (outboundJob) jobs.push(outboundJob);
    }

    if (jobs.length === 1) {
      await this.sendTiming.time('enqueue', 'outbound', { to: phone }, () =>
        this.queueService.addJob<WhatsAppOutboundJobData>(
          WHATSAPP_OUTBOUND_QUEUE,
          jobs[0],
        ),
      );
    } else if (jobs.length > 1) {
      // Deliver a multi-message reply as one ordered job. The outbound worker
      // runs concurrency: 3, so separate jobs race and arrive inconsistently
      // (e.g. a carousel's pagination line landing before or after the carousel
      // from one page to the next). A sequence job is sent in array order.
      await this.sendTiming.time('enqueue', 'outbound', { to: phone }, () =>
        this.queueService.addJob<WhatsAppOutboundJobData>(
          WHATSAPP_OUTBOUND_QUEUE,
          {
            phone,
            profileId: result.profileId ?? undefined,
            type: 'sequence',
            messages: jobs.map(toSend),
          },
        ),
      );
    }
  }
}

/** Drop the per-message recipient fields — the sequence job carries them once. */
function toSend(job: WhatsAppOutboundJobData): WhatsAppSend {
  if (job.type === 'media') {
    return { type: 'media', mediaUrl: job.mediaUrl, caption: job.caption };
  }
  if (job.type === 'template') {
    return {
      type: 'template',
      contentSid: job.contentSid,
      contentVariables: job.contentVariables,
    };
  }
  if (job.type === 'text') {
    return { type: 'text', text: job.text };
  }
  // A parsed reply is never itself a sequence; keep the type exhaustive.
  throw new Error(`Unexpected reply job type: ${job.type}`);
}

function parseReplyToJob(
  phone: string,
  profileId: string | null,
  message: string,
): WhatsAppOutboundJobData | null {
  const MEDIA_PREFIX = '[IMG:';
  const MEDIA_SUFFIX = ']';
  const TEMPLATE_PREFIX = '[TPL:';

  // Carousel / content-template send, encoded as `[TPL:<contentSid>]<jsonVars>`.
  if (message.startsWith(TEMPLATE_PREFIX) && message.includes(MEDIA_SUFFIX)) {
    const end = message.indexOf(MEDIA_SUFFIX);
    const contentSid = message.slice(TEMPLATE_PREFIX.length, end).trim();
    const rest = message.slice(end + MEDIA_SUFFIX.length).trim();
    if (!contentSid) return null;
    let contentVariables: Record<string, string> = {};
    if (rest) {
      try {
        contentVariables = JSON.parse(rest) as Record<string, string>;
      } catch {
        return null;
      }
    }
    return {
      type: 'template',
      phone,
      profileId: profileId ?? undefined,
      contentSid,
      contentVariables,
    };
  }

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
