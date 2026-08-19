import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';
import { specId, type LlmProviderSpec } from './llm.types';
import { readNumber } from '../shared/config';

@Injectable()
export class LlmBreakerService {
  private readonly logger = new Logger(LlmBreakerService.name);

  private readonly threshold: number;
  private readonly cooldownSeconds: number;
  private readonly windowSeconds: number;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.threshold = readNumber(config, 'VOVA_BREAKER_THRESHOLD', 5);
    this.cooldownSeconds = readNumber(config, 'VOVA_BREAKER_COOLDOWN_S', 60);
    this.windowSeconds = readNumber(config, 'VOVA_BREAKER_WINDOW_S', 120);
  }

  private key(spec: LlmProviderSpec, suffix: 'fails' | 'open'): string {
    return `${REDIS_KEY_PREFIX}vova:breaker:${specId(spec)}:${suffix}`;
  }

  async isOpen(spec: LlmProviderSpec): Promise<boolean> {
    try {
      return (await this.redis.exists(this.key(spec, 'open'))) === 1;
    } catch (err) {
      this.logger.warn(
        `Breaker read failed for ${specId(spec)} — treating as closed`,
        err,
      );
      return false;
    }
  }

  async recordFailure(spec: LlmProviderSpec): Promise<boolean> {
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

  async recordSuccess(spec: LlmProviderSpec): Promise<void> {
    try {
      await this.redis.del(this.key(spec, 'fails'));
    } catch (err) {
      this.logger.debug(`Breaker reset failed for ${specId(spec)}`, err);
    }
  }
}
