import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';
import { specId, type LlmProviderSpec } from './llm.types';
import { readNumber } from '../shared/config';
import { llmCircuitStateGauge } from './metrics';

/** What the scoreboard knows about one provider. */
export interface ProviderHealth {
  /** Moving average of SUCCESSFUL call latency. `null` until one lands. */
  ewmaMs: number | null;
  ok: number;
  fail: number;
}

/**
 * EWMA update, atomic across pods.
 *
 * KEYS[1] health hash · ARGV[1] alpha · ARGV[2] sample ms · ARGV[3] ttl seconds
 */
const EWMA_SCRIPT = `
local prev = tonumber(redis.call('HGET', KEYS[1], 'ewma'))
local alpha = tonumber(ARGV[1])
local sample = tonumber(ARGV[2])
local next_value = sample
if prev then next_value = alpha * sample + (1 - alpha) * prev end
redis.call('HSET', KEYS[1], 'ewma', next_value)
redis.call('HINCRBY', KEYS[1], 'ok', 1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`;

@Injectable()
export class LlmBreakerService {
  private readonly logger = new Logger(LlmBreakerService.name);

  private readonly threshold: number;
  private readonly cooldownSeconds: number;
  private readonly windowSeconds: number;
  private readonly alpha: number;
  private readonly healthTtlSeconds: number;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.threshold = readNumber(config, 'VOVA_BREAKER_THRESHOLD', 5);
    this.cooldownSeconds = readNumber(config, 'VOVA_BREAKER_COOLDOWN_S', 60);
    this.windowSeconds = readNumber(config, 'VOVA_BREAKER_WINDOW_S', 120);
    this.alpha = readNumber(config, 'VOVA_HEALTH_ALPHA', 0.3);
    // Shortish on purpose. A demoted provider gets no traffic, so its entry
    // goes stale, expires, and it returns to the default score and is tried
    // again. That loop IS the self-healing — a long TTL breaks it.
    this.healthTtlSeconds = readNumber(config, 'VOVA_HEALTH_TTL_S', 900);
  }

  private key(spec: LlmProviderSpec, suffix: 'fails' | 'open'): string {
    return `${REDIS_KEY_PREFIX}vova:breaker:${specId(spec)}:${suffix}`;
  }

  private healthKey(spec: LlmProviderSpec): string {
    return `${REDIS_KEY_PREFIX}vova:health:${specId(spec)}`;
  }

  /**
   * What each provider has actually been doing lately.
   *
   * The breaker above answers "is this one dead?", which is a cliff: five
   * failures and it disappears, four and it leads the chain as if nothing were
   * wrong. That gap is where a degrading provider lives, and on a WhatsApp
   * budget a provider taking 9s is barely better than one that is down.
   *
   * One `HGETALL` per spec in a single pipeline — the same shape
   * `system-config.service.ts:158` and `bot-inbox.service.ts:47` already use.
   * Redis being unreachable returns an empty map, and the caller keeps the
   * static order, matching `isOpen`'s existing fail-as-healthy posture.
   */
  async health(specs: LlmProviderSpec[]): Promise<Map<string, ProviderHealth>> {
    const out = new Map<string, ProviderHealth>();
    if (specs.length === 0) return out;

    try {
      const pipeline = this.redis.pipeline();
      for (const spec of specs) pipeline.hgetall(this.healthKey(spec));
      const results = await pipeline.exec();
      if (!results) return out;

      specs.forEach((spec, i) => {
        const [err, raw] = results[i] ?? [];
        if (err || !raw) return;
        const hash = raw as Record<string, string>;
        out.set(specId(spec), {
          ewmaMs: hash.ewma ? Number(hash.ewma) : null,
          ok: Number(hash.ok ?? 0),
          fail: Number(hash.fail ?? 0),
        });
      });
    } catch (err) {
      this.logger.debug(
        'Health read failed — falling back to static order',
        err,
      );
    }

    return out;
  }

  /**
   * Fold one successful call's latency into the provider's moving average.
   *
   * **Successes only.** Failure latency must never enter this: a provider that
   * 401s in 200ms would otherwise score as the fastest thing in the chain and
   * be promoted to lead it. Failures are counted separately and enter the score
   * as a divisor instead.
   *
   * A Lua `EVAL` because the update is read-modify-write and several pods share
   * the key — one round trip, atomic, no lost updates.
   */
  private async recordLatency(
    spec: LlmProviderSpec,
    latencyMs: number,
  ): Promise<void> {
    try {
      await this.redis.eval(
        EWMA_SCRIPT,
        1,
        this.healthKey(spec),
        String(this.alpha),
        String(latencyMs),
        String(this.healthTtlSeconds),
      );
    } catch (err) {
      this.logger.debug(`Health write failed for ${specId(spec)}`, err);
    }
  }

  async isOpen(spec: LlmProviderSpec): Promise<boolean> {
    try {
      const open = (await this.redis.exists(this.key(spec, 'open'))) === 1;
      // The gauge is refreshed on the READ, not only on the transitions,
      // because a breaker closes by key expiry — there is no event to hang a
      // "back to zero" on. `usableChain` calls this per request per provider,
      // so the series stays truthful without a poller of its own.
      llmCircuitStateGauge.set(
        { provider: spec.provider, model: spec.model },
        open ? 1 : 0,
      );
      return open;
    } catch (err) {
      this.logger.warn(
        `Breaker read failed for ${specId(spec)} — treating as closed`,
        err,
      );
      return false;
    }
  }

  async recordFailure(spec: LlmProviderSpec): Promise<boolean> {
    // The scoreboard's failure half. Deliberately does NOT touch `ewma`: see
    // `recordLatency` — a fast failure must not read as a fast provider.
    try {
      await this.redis
        .multi()
        .hincrby(this.healthKey(spec), 'fail', 1)
        .expire(this.healthKey(spec), this.healthTtlSeconds)
        .exec();
    } catch (err) {
      this.logger.debug(`Health failure write failed for ${specId(spec)}`, err);
    }

    try {
      const failKey = this.key(spec, 'fails');
      const count = await this.redis.incr(failKey);
      if (count === 1) {
        await this.redis.expire(failKey, this.windowSeconds);
      }
      if (count < this.threshold) return false;

      const opened = await this.redis.set(
        this.key(spec, 'open'),
        '1',
        'EX',
        this.cooldownSeconds,
        'NX',
      );
      if (opened) {
        llmCircuitStateGauge.set(
          { provider: spec.provider, model: spec.model },
          1,
        );
        this.logger.warn(
          `Breaker OPEN for ${specId(spec)} after ${count} failures — ` +
            `skipping it for ${this.cooldownSeconds}s`,
        );
        return true;
      }
      return false;
    } catch (err) {
      this.logger.warn(`Breaker write failed for ${specId(spec)}`, err);
      return false;
    }
  }

  /**
   * `latencyMs` is optional so the breaker keeps working for callers that do
   * not measure — but every real call does, and it is what feeds the ordering.
   */
  async recordSuccess(
    spec: LlmProviderSpec,
    latencyMs?: number,
  ): Promise<void> {
    try {
      await this.redis.del(this.key(spec, 'fails'));
    } catch (err) {
      this.logger.debug(`Breaker reset failed for ${specId(spec)}`, err);
    }

    if (typeof latencyMs === 'number' && Number.isFinite(latencyMs)) {
      await this.recordLatency(spec, latencyMs);
    }
  }
}
