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
import type { InboundEvent } from '../contracts';
import { toBotInput } from './inbound-normalizer';

const MSG_IDEMPOTENCY_TTL = 5 * 60; // 5 minutes
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
  ) {}

  /**
   * Process one batch of normalized events.
   *
   * Never throws: a provider retries on any non-2xx, and Meta retries hard
   * enough that a persistent 500 costs a subscription. One bad event must not
   * take the rest of the batch down with it.
   */
  async ingest(events: InboundEvent[]): Promise<void> {
    for (const event of events) {
      try {
        if (event.kind === 'status') {
          await this.handleStatus(event);
        } else {
          await this.handleMessage(event);
        }
      } catch (err) {
        this.logger.error(
          `Failed to ingest ${event.kind} event ${event.providerMessageId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async handleStatus(
    event: Extract<InboundEvent, { kind: 'status' }>,
  ): Promise<void> {
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
  ): Promise<void> {
    const text = toBotInput(event);
    if (text === null) return;

    const phone = event.from;

    if (
      event.providerMessageId &&
      !(await this.claim(event.providerMessageId))
    ) {
      this.logger.debug(
        `Duplicate webhook ignored: ${event.providerMessageId}`,
      );
      return;
    }

    this.logger.log(
      `Incoming WhatsApp (${event.provider}) from ${phone}: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
    );

    if (!(await this.withinRateLimit(phone))) return;

    // Enqueue rather than handle inline: the webhook has to return in well
    // under the provider's timeout or it retries, multiplying load.
    await this.sendTiming.time('enqueue', 'inbound', { to: phone }, () =>
      this.queueService.addJob<WhatsAppInboundJobData>(WHATSAPP_INBOUND_QUEUE, {
        phone,
        text,
        messageSid: event.providerMessageId || undefined,
      }),
    );
  }

  /** `SET NX` — true if this is the first time we have seen the id. */
  private async claim(providerMessageId: string): Promise<boolean> {
    const key = `${REDIS_KEY_PREFIX}wa:msg:${providerMessageId}`;
    const claimed = await this.redis.set(
      key,
      '1',
      'EX',
      MSG_IDEMPOTENCY_TTL,
      'NX',
    );
    return claimed !== null;
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
