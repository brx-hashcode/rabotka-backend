import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
  Inject,
} from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigCategory } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';
import {
  DEFAULT_SYSTEM_CONFIGS,
  STORAGE_ENV_OVERRIDES,
} from './system-config.constants';

const CACHE_PREFIX = `${REDIS_KEY_PREFIX}syscfg:`;
const CACHE_TTL_SECONDS = 300; // 5 minutes
const SEED_MAX_RETRIES = 10;
const SEED_RETRY_DELAY_MS = 2000;

@Injectable()
export class SystemConfigService implements OnModuleInit {
  private readonly logger = new Logger(SystemConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaultsWithRetry();
  }

  private async seedDefaultsWithRetry(): Promise<void> {
    let attempt = 1;
    // Postgres may not be ready yet when Nest modules initialize.
    while (attempt <= SEED_MAX_RETRIES) {
      try {
        await this.seedDefaults();
        return;
      } catch (error: unknown) {
        if (
          !this.isRetryableConnectionError(error) ||
          attempt === SEED_MAX_RETRIES
        ) {
          throw error;
        }
        this.logger.warn(
          `DB connection not ready while seeding system config (attempt ${attempt}/${SEED_MAX_RETRIES}). Retrying in ${SEED_RETRY_DELAY_MS}ms...`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, SEED_RETRY_DELAY_MS),
        );
        attempt += 1;
      }
    }
  }

  private isRetryableConnectionError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as { code?: string; message?: string };
    const code = record.code ?? '';
    const message = (record.message ?? '').toLowerCase();
    return (
      code === 'ECONNREFUSED' ||
      code === 'P1001' ||
      code === 'ETIMEDOUT' ||
      message.includes("can't reach database server")
    );
  }

  private async seedDefaults(): Promise<void> {
    for (const cfg of DEFAULT_SYSTEM_CONFIGS) {
      await this.prisma.systemConfig.upsert({
        where: { key: cfg.key },
        create: {
          key: cfg.key,
          value: cfg.value,
          category: cfg.category,
          label: cfg.label,
          is_secret: cfg.isSecret,
        },
        // On subsequent starts: only refresh metadata, never overwrite admin-set values
        update: {
          category: cfg.category,
          label: cfg.label,
          is_secret: cfg.isSecret,
        },
      });
    }
    this.logger.log(
      `System config seeded (${DEFAULT_SYSTEM_CONFIGS.length} keys)`,
    );
  }

  // ── Core get/set ──────────────────────────────────────────────────────────

  async get(key: string, fallback = ''): Promise<string> {
    const cacheKey = `${CACHE_PREFIX}${key}`;
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) return cached;

    // Stampede protection: only one caller fills the cache; others wait briefly then re-read
    const lockKey = `${CACHE_PREFIX}lock:${key}`;
    const acquired = await this.redis.set(lockKey, '1', 'EX', 2, 'NX');
    if (!acquired) {
      // Another caller is filling; wait and return whatever is cached (or fallback)
      await new Promise((resolve) => setTimeout(resolve, 50));
      return (await this.redis.get(cacheKey)) ?? fallback;
    }

    try {
      const row = await this.prisma.systemConfig.findUnique({ where: { key } });
      const value = row?.value ?? fallback;
      await this.redis.set(cacheKey, value, 'EX', CACHE_TTL_SECONDS);
      return value;
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async mgetBatch(
    entries: { key: string; fallback?: string }[],
  ): Promise<(string | null)[]> {
    const cacheKeys = entries.map((e) => `${CACHE_PREFIX}${e.key}`);
    const cached = await this.redis.mget(...cacheKeys);

    // Bounded by `entries`, not by what Redis returned. ioredis mirrors the key
    // count, but indexing `entries[i]` off a longer response throws — and the
    // symptom is an unrelated "Cannot read properties of undefined" deep in a
    // fee lookup, which is a poor trade for one comparison.
    const missIndices: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if ((cached[i] ?? null) === null) missIndices.push(i);
    }

    if (missIndices.length > 0) {
      const missKeys = missIndices.map((i) => entries[i].key);
      const rows = await this.prisma.systemConfig.findMany({
        where: { key: { in: missKeys } },
        select: { key: true, value: true },
      });
      const rowMap = new Map(rows.map((r) => [r.key, r.value]));
      const pipeline = this.redis.pipeline();
      for (const i of missIndices) {
        const value = rowMap.get(entries[i].key) ?? entries[i].fallback ?? null;
        cached[i] = value;
        if (value !== null) {
          pipeline.set(cacheKeys[i], value, 'EX', CACHE_TTL_SECONDS);
        }
      }
      await pipeline.exec();
    }

    // Map over `entries`, not `cached`: the result must always have one slot per
    // requested key. Mapping the cache response instead means a short response
    // silently drops trailing values, and the caller's destructuring turns them
    // into undefined → NaN rather than falling back.
    return entries.map((e, i) => cached[i] ?? e.fallback ?? null);
  }

  // Fee keys that must be positive integers — setting them to 0 or negative
  // would break penalty/unlock/scoring logic throughout the app.
  private static readonly POSITIVE_INT_KEYS = new Set([
    'fees.late_cancellation_penalty_fcfa',
    'fees.late_cancellation_score_deduction',
    'fees.cancellation_threshold_hours',
    'fees.reliability_score_min',
    'fees.employer_late_cancel_score_deduction',
    'fees.billing_block_threshold',
    'fees.max_daily_applications',
    'fees.contact_unlock_fee_employer',
    'fees.contact_unlock_fee_worker',
    'fees.contact_unlock_expiry_hours',
    'fees.contact_recommendation_fee_employer',
    'fees.welcome_credit_worker',
    'fees.welcome_credit_employer',
    'matching.max_notification_workers',
  ]);

  /**
   * Score thresholds. These are compared against relevance values that are
   * normalized to [0,1], so anything outside that range is not "strict" — it
   * silently empties every feed that uses it, with no error and no log. Guard it
   * at write time.
   */
  private static readonly UNIT_INTERVAL_KEYS = new Set([
    'matching.min_notification_score',
    'matching.recommendation_min_score',
  ]);

  async set(key: string, value: string, adminId?: string): Promise<void> {
    if (SystemConfigService.POSITIVE_INT_KEYS.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new BadRequestException(
          `La valeur de "${key}" doit être un entier strictement positif`,
        );
      }
    }
    if (SystemConfigService.UNIT_INTERVAL_KEYS.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new BadRequestException(
          `La valeur de "${key}" doit être un nombre entre 0 et 1`,
        );
      }
    }
    await this.prisma.systemConfig.update({
      where: { key },
      data: { value, updated_by: adminId ?? null },
    });
    await this.redis.del(`${CACHE_PREFIX}${key}`);
    this.logger.log(`Config updated: ${key} by ${adminId ?? 'system'}`);
  }

  async getAll(category?: ConfigCategory) {
    const rows = await this.prisma.systemConfig.findMany({
      where: category ? { category } : undefined,
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });
    return rows.map((r) => ({
      key: r.key,
      value: r.is_secret ? '***' : r.value,
      category: r.category,
      label: r.label,
      isSecret: r.is_secret,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    }));
  }

  async getOne(key: string) {
    const row = await this.prisma.systemConfig.findUnique({ where: { key } });
    if (!row) return null;
    return {
      key: row.key,
      value: row.is_secret ? '***' : row.value,
      category: row.category,
      label: row.label,
      isSecret: row.is_secret,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  /** Returns the raw (unmasked) value — for internal service use only */
  async getRaw(key: string, fallback = ''): Promise<string> {
    return this.get(key, fallback);
  }

  // ── Typed getters ─────────────────────────────────────────────────────────

  async isSimilarityEnabled(): Promise<boolean> {
    const val = await this.get('matching.use_embeddings', 'false');
    return val === 'true';
  }

  async getMinNotificationScore(): Promise<number> {
    const val = await this.get('matching.min_notification_score', '0.55');
    const n = parseFloat(val);
    return Number.isNaN(n) ? 0.55 : n;
  }

  async isRecommendationEnabled(): Promise<boolean> {
    const val = await this.get('matching.recommendations_enabled', 'true');
    return val === 'true';
  }

  async getMaxNotificationWorkers(): Promise<number> {
    const val = await this.get('matching.max_notification_workers', '20');
    const n = Number.parseInt(val, 10);
    return Number.isNaN(n) || n < 1 ? 20 : n;
  }

  /**
   * Whether a worker must be KYC-verified to be notified about a new offer.
   *
   * Defaults to `false` so that moving the notification path onto the v2 ranker
   * — whose candidate query requires VERIFIED — does not silently drop every
   * unverified recipient the legacy path used to reach. Flip it on once the
   * volume change has been measured; the feed has always required verification
   * and is unaffected either way.
   */
  async notifyRequiresVerified(): Promise<boolean> {
    const val = await this.get('matching.notify_require_verified', 'false');
    return val === 'true';
  }

  /** Minimum minutes between two job recommendation notifications for the same worker. */
  async getNotificationCooldownMinutes(): Promise<number> {
    const val = await this.get('matching.notification_cooldown_minutes', '60');
    const n = Number.parseInt(val, 10);
    return Number.isNaN(n) || n < 0 ? 60 : n;
  }

  async getContactInfo() {
    const [email, phone, address] = await this.mgetBatch([
      { key: 'contact.email', fallback: 'contact@rabotka.com' },
      { key: 'contact.phone', fallback: '' },
      { key: 'contact.address', fallback: '' },
    ]);
    return { email, phone, address };
  }

  async getEmailFooterInfo() {
    const [description, email, address] = await this.mgetBatch([
      {
        key: 'general.description',
        fallback:
          'Plateforme de mise en relation entre employeurs et travailleurs informels en Afrique.',
      },
      { key: 'contact.email', fallback: 'contact@rabotka.com' },
      { key: 'contact.address', fallback: '' },
    ]);
    return { description, email, address };
  }

  async getFees() {
    const [
      penalty,
      scoreDed,
      threshold,
      scoreMin,
      empLateCancelDed,
      billingBlock,
      maxDailyApps,
      completionReward,
      ratingDelta1,
      ratingDelta2,
      ratingDelta3,
      ratingDelta4,
      ratingDelta5,
    ] = await this.mgetBatch([
      { key: 'fees.late_cancellation_penalty_fcfa', fallback: '5000' },
      { key: 'fees.late_cancellation_score_deduction', fallback: '5' },
      { key: 'fees.cancellation_threshold_hours', fallback: '4' },
      { key: 'fees.reliability_score_min', fallback: '50' },
      { key: 'fees.employer_late_cancel_score_deduction', fallback: '5' },
      { key: 'fees.billing_block_threshold', fallback: '2' },
      { key: 'fees.max_daily_applications', fallback: '10' },
      { key: 'fees.completion_score_reward', fallback: '1' },
      { key: 'fees.rating_score_delta_1', fallback: '-4' },
      { key: 'fees.rating_score_delta_2', fallback: '-2' },
      { key: 'fees.rating_score_delta_3', fallback: '0' },
      { key: 'fees.rating_score_delta_4', fallback: '1' },
      { key: 'fees.rating_score_delta_5', fallback: '3' },
    ]);
    return {
      lateCancellationPenaltyFcfa: Number(penalty),
      lateCancellationScoreDeduction: Number(scoreDed),
      cancellationThresholdHours: Number(threshold),
      reliabilityScoreMin: Number(scoreMin),
      employerLateCancelScoreDeduction: Number(empLateCancelDed),
      billingBlockThreshold: Number(billingBlock),
      maxDailyApplications: Number(maxDailyApps),
      completionScoreReward: Number(completionReward),
      ratingScoreDeltas: {
        1: Number(ratingDelta1),
        2: Number(ratingDelta2),
        3: Number(ratingDelta3),
        4: Number(ratingDelta4),
        5: Number(ratingDelta5),
      } as Record<number, number>,
    };
  }

  async getContactUnlockFees() {
    const [employerFee, workerFee, expiryHours] = await this.mgetBatch([
      { key: 'fees.contact_unlock_fee_employer', fallback: '500' },
      { key: 'fees.contact_unlock_fee_worker', fallback: '100' },
      { key: 'fees.contact_unlock_expiry_hours' },
    ]);
    if (!expiryHours) {
      throw new Error(
        'fees.contact_unlock_expiry_hours is not configured in SystemConfig',
      );
    }
    return {
      employerFeeFcfa: Number(employerFee),
      workerFeeFcfa: Number(workerFee),
      expiryHours: Number(expiryHours),
    };
  }

  async getMatchingReliabilityThreshold(): Promise<number> {
    const val = await this.get('matching.reliability_threshold', '50');
    return Number(val);
  }

  async getRecommendationContactFee(): Promise<number> {
    const val = await this.get(
      'fees.contact_recommendation_fee_employer',
      '1000',
    );
    return Number(val);
  }

  async getRecommendationMinScore(): Promise<number> {
    const val = await this.get('matching.recommendation_min_score', '0.3');
    const n = Number(val);
    return Number.isFinite(n) ? n : 0.3;
  }

  async getWelcomeCredits() {
    const [workerCredit, employerCredit] = await Promise.all([
      this.get('fees.welcome_credit_worker', '100'),
      this.get('fees.welcome_credit_employer', '500'),
    ]);
    return {
      workerCreditFcfa: Number(workerCredit),
      employerCreditFcfa: Number(employerCredit),
    };
  }

  async getStorageDriver(): Promise<string> {
    return this.get('storage.driver', 'S3');
  }

  /**
   * Returns a map of env-var-name → db-value for the given storage driver.
   * Empty string values are omitted so the original ConfigService env var takes precedence.
   */
  async getStorageEnvOverrides(
    driver: string,
  ): Promise<Record<string, string>> {
    const mapping = STORAGE_ENV_OVERRIDES[driver.toUpperCase()] ?? {};
    const overrides: Record<string, string> = {};
    await Promise.all(
      Object.entries(mapping).map(async ([envKey, cfgKey]) => {
        const val = await this.get(cfgKey, '');
        if (val !== '') overrides[envKey] = val;
      }),
    );
    return overrides;
  }
}
