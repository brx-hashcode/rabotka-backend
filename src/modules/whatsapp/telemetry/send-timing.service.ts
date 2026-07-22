import { Inject, Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';
import { SendDirection, SendStage, sendDurationHistogram } from './metrics';

export interface TimingMeta {
  messageSid?: string;
  to?: string;
  templateSid?: string;
}

const TIMING_KEY_PREFIX = `${REDIS_KEY_PREFIX}wa:timing:`;
const TIMING_TTL_SECONDS = 900;

@Injectable()
export class SendTimingService {
  constructor(@Inject(REDIS_CONNECTION) private readonly redis: Redis) {}

  observe(
    stage: SendStage,
    direction: SendDirection,
    durationMs: number,
    meta: TimingMeta = {},
  ): void {
    sendDurationHistogram.observe({ stage, direction }, durationMs);
    process.stdout.write(
      JSON.stringify({
        log: 'wa_send_timing',
        stage,
        direction,
        durationMs: Math.round(durationMs * 100) / 100,
        messageSid: meta.messageSid ?? null,
        to: meta.to ?? null,
        templateSid: meta.templateSid ?? null,
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
  }

  async time<T>(
    stage: SendStage,
    direction: SendDirection,
    meta: TimingMeta,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(stage, direction, performance.now() - start, meta);
    }
  }

  async markSent(sid: string, meta: TimingMeta): Promise<void> {
    try {
      await this.redis.set(
        `${TIMING_KEY_PREFIX}${sid}`,
        JSON.stringify({
          sentAt: Date.now(),
          to: meta.to ?? null,
          templateSid: meta.templateSid ?? null,
        }),
        'EX',
        TIMING_TTL_SECONDS,
      );
    } catch {
      // Telemetry must never break a send.
    }
  }

  async recordDelivered(sid: string): Promise<void> {
    try {
      const key = `${TIMING_KEY_PREFIX}${sid}`;
      const raw = await this.redis.get(key);
      if (!raw) return;
      const { sentAt, to, templateSid } = JSON.parse(raw) as {
        sentAt: number;
        to: string | null;
        templateSid: string | null;
      };
      this.observe('delivery', 'outbound', Date.now() - sentAt, {
        messageSid: sid,
        to: to ?? undefined,
        templateSid: templateSid ?? undefined,
      });
      await this.redis.del(key);
    } catch {
      // Telemetry must never break the webhook.
    }
  }
}
