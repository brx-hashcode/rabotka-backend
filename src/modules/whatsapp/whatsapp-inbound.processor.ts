import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConversationService } from '../conversation/conversation.service';
import {
  QueueService,
  type ProcessedJob,
} from '../../common/services/queue/queue.service';
import {
  IdempotencyService,
  INBOUND_TTL_SECONDS,
  IN_FLIGHT_TTL_SECONDS,
  inboundKey,
  inFlightKey,
} from '../../common/services/idempotency/idempotency.service';
import { webhookDuplicateDroppedCounter } from './telemetry/metrics';
import {
  WHATSAPP_INBOUND_QUEUE,
  WHATSAPP_OUTBOUND_QUEUE,
} from '../../common/services/queue/queue.module';
import type {
  WhatsAppOutboundJobData,
  WhatsAppSend,
} from './whatsapp-outbound.processor';
import { SendTimingService } from './telemetry/send-timing.service';
import { isTemplateKey } from '../../common/constants/whatsapp-templates';

export type WhatsAppInboundJobData = {
  phone: string;
  text: string;
  messageSid?: string;
  /** Which webhook produced this, for the duplicate metric's label. */
  provider?: string;
  /** `req.requestId` from the webhook, so worker logs join the request's. */
  correlationId?: string;
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
    private readonly idempotency: IdempotencyService,
  ) {}

  onApplicationBootstrap(): void {
    this.queueService.createWorker<WhatsAppInboundJobData>(
      WHATSAPP_INBOUND_QUEUE,
      (job) => this.process(job),
      { concurrency: 5 },
    );
    this.logger.log('WhatsApp inbound worker registered (API process)');
  }

  async process(job: ProcessedJob<WhatsAppInboundJobData>): Promise<void> {
    const { phone, text, messageSid, provider, correlationId } = job.data;

    this.logger.log(
      `Inbound job wamid=${messageSid ?? 'none'} provider=${provider ?? 'unknown'} ` +
        `attempt=${job.attemptsMade} correlationId=${correlationId ?? 'none'}`,
    );

    // Dedup lives HERE, not in the controller, because this is the only point
    // that sees every path to handling: a Meta replay, a BullMQ retry after a
    // throw, and a stalled-job re-run all arrive through this worker.
    //
    // TWO keys, not one. The first version used a single key claimed before
    // handling, which meant anything that threw afterwards left it set — the
    // retry read it as a duplicate and dropped the message for seven days.
    //
    //   done  written only after the work succeeds; survives 7 days
    //   lock  held for the duration of one attempt; released in `finally`
    //
    // Returning rather than throwing on a duplicate is deliberate: a throw
    // would be retried by BullMQ, which is the behaviour being suppressed.
    if (messageSid) {
      if (await this.idempotency.has(inboundKey(messageSid))) {
        webhookDuplicateDroppedCounter.inc({ provider: provider ?? 'unknown' });
        this.logger.debug(
          `Already handled, dropping: wamid=${messageSid} attempt=${job.attemptsMade}`,
        );
        return;
      }

      const gotLock = await this.idempotency.claim(
        inFlightKey(messageSid),
        IN_FLIGHT_TTL_SECONDS,
      );
      if (!gotLock) {
        // Another attempt is mid-flight. Returning rather than throwing lets it
        // finish; if it fails, it releases the lock and BullMQ's next attempt
        // picks the message up.
        this.logger.debug(
          `Already in flight, deferring: wamid=${messageSid} attempt=${job.attemptsMade}`,
        );
        return;
      }
    }

    try {
      await this.handle(job.data, messageSid);
    } finally {
      // The `finally` is the mechanism; the lock's TTL is only a backstop for a
      // worker that died before reaching this line.
      if (messageSid) await this.idempotency.release(inFlightKey(messageSid));
    }
  }

  /**
   * The actual work. Split out so the caller can wrap it in the in-flight lock
   * without the happy path being buried in bookkeeping.
   *
   * Marks the message done only once a reply is enqueued — anything that throws
   * before that point leaves no marker, so the retry does the work again.
   */
  private async handle(
    data: WhatsAppInboundJobData,
    messageSid: string | undefined,
  ): Promise<void> {
    const { phone, text } = data;

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
          { ...jobs[0], replyToMessageId: messageSid },
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
            replyToMessageId: messageSid,
            type: 'sequence',
            messages: jobs.map(toSend),
          },
        ),
      );
    }

    // Last line on purpose. Everything above can throw — the bot graph, the
    // enqueue — and until this runs there is no marker, so a BullMQ retry does
    // the work again instead of mistaking the failure for a duplicate.
    //
    // A message that legitimately produces no reply still counts as handled:
    // re-running it would produce no reply again, and leaving it unmarked lets
    // a provider replay re-enter the bot graph days later.
    if (messageSid) {
      await this.idempotency.claim(inboundKey(messageSid), INBOUND_TTL_SECONDS);
    }
  }
}

/** Drop the per-message recipient fields — the sequence job carries them once. */
function toSend(job: WhatsAppOutboundJobData): WhatsAppSend {
  if (job.type === 'media') {
    return { type: 'media', mediaUrl: job.mediaUrl, caption: job.caption };
  }
  if (job.type === 'template') {
    // parseReplyToJob only ever produces the key-shaped variant; the legacy
    // SID shape exists solely to drain jobs already in Redis and never reaches
    // a sequence.
    if (!('templateKey' in job)) {
      throw new Error(
        'Bot replies must carry a template key, not a content SID',
      );
    }
    return {
      type: 'template',
      templateKey: job.templateKey,
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

  // Template send, encoded as `[TPL:<templateKey>]<jsonVars>`.
  if (message.startsWith(TEMPLATE_PREFIX) && message.includes(MEDIA_SUFFIX)) {
    const end = message.indexOf(MEDIA_SUFFIX);
    const templateKey = message.slice(TEMPLATE_PREFIX.length, end).trim();
    const rest = message.slice(end + MEDIA_SUFFIX.length).trim();
    // An unknown key means a flow built a reply for a template that is not in
    // the registry. Dropping it is right: enqueuing it would fail the job and
    // retry twice before the DLQ, for a reply that can never succeed.
    if (!templateKey || !isTemplateKey(templateKey)) return null;
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
      templateKey,
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
