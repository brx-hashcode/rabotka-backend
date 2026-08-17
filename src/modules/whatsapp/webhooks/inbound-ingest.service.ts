import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';
import { QueueService } from '../../../common/services/queue/queue.service';
import { WHATSAPP_INBOUND_QUEUE } from '../../../common/services/queue/queue.module';
import type { WhatsAppInboundJobData } from '../whatsapp-inbound.processor';
import { SendTimingService } from '../telemetry/send-timing.service';
import {
  WHATSAPP_PROVIDER,
  type InboundEvent,
  type WhatsappProvider,
} from '../contracts';
import { toBotInput } from './inbound-normalizer';
import { WhatsAppFeedbackService } from '../feedback/whatsapp-feedback.service';
import {
  IdempotencyService,
  INBOUND_TTL_SECONDS,
  inboundKey,
} from '../../../common/services/idempotency/idempotency.service';
import { webhookDuplicateDroppedCounter } from '../telemetry/metrics';
import { WhatsappMessageLogService } from '../logging/whatsapp-message-log.service';

const RATE_LIMIT_MAX = 30; // max messages per window
const RATE_LIMIT_WINDOW = 60; // seconds

/**
 * What both webhook controllers do once an event is verified and normalized.
 *
 * Extracted so the Cloud path cannot drift from the Twilio one on the parts
 * that are not provider-specific: de-duplication, per-phone rate limiting, and
 * handing off to the queue fast enough that the provider does not retry.
 *
 * The Redis keys are shared between providers deliberately. Twilio SIDs
 * (`SM…`/`MM…`) and Cloud wamids (`wamid.…`) cannot collide, and a shared
 * namespace means a message is still de-duplicated across a provider flip.
 */
@Injectable()
export class InboundIngestService {
  private readonly logger = new Logger(InboundIngestService.name);

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    private readonly queueService: QueueService,
    private readonly sendTiming: SendTimingService,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsappProvider,
    private readonly feedback: WhatsAppFeedbackService,
    private readonly idempotency: IdempotencyService,
    private readonly messageLog: WhatsappMessageLogService,
  ) {}

  /**
   * Process one batch of normalized events.
   *
   * Never throws: a provider retries on any non-2xx, and Meta retries hard
   * enough that a persistent 500 costs a subscription. One bad event must not
   * take the rest of the batch down with it.
   */
  async ingest(events: InboundEvent[], correlationId?: string): Promise<void> {
    for (const event of events) {
      try {
        if (event.kind === 'status') {
          await this.handleStatus(event);
        } else {
          await this.handleMessage(event, correlationId);
        }
      } catch (err) {
        this.logger.error(
          `Failed to ingest ${event.kind} event ${event.providerMessageId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Record a delivery receipt.
   *
   * Every status is persisted, not just the interesting-looking ones. This used
   * to drop `sent` and `read` outright and reduce `failed` to a log line, which
   * is why the admin back office could not answer "did it arrive?" — the answer
   * existed, in a webhook, for the microsecond before it was discarded.
   */
  private async handleStatus(
    event: Extract<InboundEvent, { kind: 'status' }>,
  ): Promise<void> {
    await this.messageLog.applyStatus(event);

    if (event.status === 'delivered') {
      await this.sendTiming.recordDelivered(event.providerMessageId);
      return;
    }
    if (event.status === 'failed' && event.error) {
      this.logger.warn(
        `WhatsApp delivery failed for ${event.providerMessageId} ` +
          `[${event.error.code}/${String(event.error.providerCode)}]: ${event.error.message}`,
      );
    }
  }

  private async handleMessage(
    event: Extract<InboundEvent, { kind: 'message' }>,
    correlationId?: string,
  ): Promise<void> {
    // A submitted Flow is a form, not something the bot should answer. Handled
    // here rather than through the queue: it writes one row and produces no
    // reply, so the round trip would buy nothing.
    //
    // This branch keeps its own claim precisely because it never reaches the
    // worker, so the worker's claim cannot cover it.
    if (event.content.type === 'flow_reply') {
      if (
        event.providerMessageId &&
        !(await this.idempotency.claim(
          inboundKey(event.providerMessageId),
          INBOUND_TTL_SECONDS,
        ))
      ) {
        webhookDuplicateDroppedCounter.inc({ provider: event.provider });
        this.logger.debug(
          `Duplicate flow reply dropped: ${event.providerMessageId}`,
        );
        return;
      }
      await this.feedback.handleSubmission(event);
      return;
    }

    const text = toBotInput(event);
    if (text === null) {
      // Logged rather than dropped silently. Working out that a welcome card
      // was answering a REACTION took reading the normalizer, because nothing
      // recorded what type had arrived — the content type is the one fact that
      // makes an unprompted reply diagnosable.
      this.logger.debug(
        `Inbound ${event.content.type}` +
          (event.content.type === 'unsupported'
            ? ` (${event.content.rawType})`
            : '') +
          ` from ${event.from} — nothing for the bot to answer`,
      );
      return;
    }

    const phone = event.from;

    // No claim here. It moved into the inbound WORKER, which is the only place
    // that sees BullMQ retries and stalled-job re-runs as well as provider
    // replays. Claiming in both would be worse than claiming in one: the
    // controller would win the race every time and the worker's claim — the one
    // that actually covers retries — would never fire.

    this.logger.log(
      `Incoming WhatsApp (${event.provider}) from ${phone}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
    );

    if (!(await this.withinRateLimit(phone))) return;

    // Acknowledge before the work starts. The bot round-trip is a database
    // read, a flow evaluation and a send, which is long enough for a reader to
    // wonder whether the message arrived — the blue ticks say it did, and the
    // composer bubble says something is happening.
    //
    // Deliberately NOT awaited: this is a courtesy, and a slow or failing
    // acknowledgement must never delay the reply it is announcing. No-ops on
    // Twilio, which has neither.
    void this.acknowledge(event.providerMessageId);

    // Enqueue rather than handle inline: the webhook has to return in well
    // under the provider's timeout or it retries, multiplying load.
    //
    // `jobId` is the cheap first line of defence — BullMQ refuses a second add
    // under an id it already holds, so a replay inside the retention window
    // never becomes a job at all. It is NOT sufficient alone: removeOnComplete
    // drops the record after an hour, and the duplicate we chased arrived at 38
    // minutes. The worker's claim is what covers the full 7 days.
    await this.sendTiming.time('enqueue', 'inbound', { to: phone }, () =>
      this.queueService.addJob<WhatsAppInboundJobData>(
        WHATSAPP_INBOUND_QUEUE,
        {
          phone,
          text,
          messageSid: event.providerMessageId || undefined,
          provider: event.provider,
          correlationId,
        },
        event.providerMessageId
          ? { jobId: `wa-in-${event.providerMessageId}` }
          : undefined,
      ),
    );
  }

  /**
   * Blue ticks, then the typing bubble.
   *
   * On Meta these are one endpoint: the typing indicator rides on the read
   * receipt, so `sendTypingIndicator` also marks the message read. Both are
   * called anyway — `markAsRead` alone is what a provider without typing
   * support can still honour, and the pair reads as the intent rather than as
   * a trick of Meta's API shape.
   *
   * The bubble clears itself after ~25s, or the moment a message is sent.
   */
  private async acknowledge(providerMessageId: string): Promise<void> {
    if (!providerMessageId) return;
    try {
      if (this.provider.capabilities.readReceipts) {
        await this.provider.markAsRead(providerMessageId);
      }
      if (this.provider.capabilities.typingIndicator) {
        await this.provider.sendTypingIndicator(providerMessageId);
      }
    } catch (err) {
      this.logger.debug(
        `Could not acknowledge ${providerMessageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Per-phone rate limit. Atomic INCR + EXPIRE NX, so a crash between the two
   * cannot leave a key without a TTL and lock the number out permanently.
   */
  private async withinRateLimit(phone: string): Promise<boolean> {
    const key = `${REDIS_KEY_PREFIX}wa:rate:${phone}`;
    const [[, count]] = (await this.redis
      .pipeline()
      .incr(key)
      .expire(key, RATE_LIMIT_WINDOW, 'NX')
      .exec()) as [[null, number], [null, number]];

    if (count > RATE_LIMIT_MAX) {
      this.logger.warn(`Rate limit exceeded for ${phone}: ${count} msgs/min`);
      return false;
    }
    return true;
  }
}
