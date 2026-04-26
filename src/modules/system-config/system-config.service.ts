import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigCategory } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { REDIS_CONNECTION, REDIS_KEY_PREFIX } from '../../common/services/redis/redis.constants';
import {
  DEFAULT_SYSTEM_CONFIGS,
  MONETBIL_ENV_OVERRIDES,
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

  private async mgetBatch(entries: { key: string; fallback: string }[]): Promise<string[]> {
    const cacheKeys = entries.map((e) => `${CACHE_PREFIX}${e.key}`);
    const cached = await this.redis.mget(...cacheKeys);

    const missIndices: number[] = [];
    cached.forEach((v, i) => { if (v === null) missIndices.push(i); });

    if (missIndices.length > 0) {
      const missKeys = missIndices.map((i) => entries[i].key);
      const rows = await this.prisma.systemConfig.findMany({
        where: { key: { in: missKeys } },
        select: { key: true, value: true },
      });
      const rowMap = new Map(rows.map((r) => [r.key, r.value]));
      const pipeline = this.redis.pipeline();
      for (const i of missIndices) {
        const value = rowMap.get(entries[i].key) ?? entries[i].fallback;
        cached[i] = value;
        pipeline.set(cacheKeys[i], value, 'EX', CACHE_TTL_SECONDS);
      }
      await pipeline.exec();
    }

    return cached.map((v, i) => v ?? entries[i].fallback);
  }

  async set(key: string, value: string, adminId?: string): Promise<void> {
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

  async getContactInfo() {
    const [email, phone, address, orangeMoney, airtelMoney] = await this.mgetBatch([
      { key: 'contact.email', fallback: 'contact@rabotka.com' },
      { key: 'contact.phone', fallback: '' },
      { key: 'contact.address', fallback: '' },
      { key: 'contact.orange_money_number', fallback: '06 000 0000' },
      { key: 'contact.airtel_money_number', fallback: '07 000 0000' },
    ]);
    return {
      email,
      phone,
      address,
      orangeMoneyNumber: orangeMoney,
      airtelMoneyNumber: airtelMoney,
    };
  }

  async getFees() {
    const [penalty, scoreDed, threshold, scoreMin, empCancel, empGhost, billingBlock] =
      await this.mgetBatch([
        { key: 'fees.late_cancellation_penalty_fcfa', fallback: '5000' },
        { key: 'fees.late_cancellation_score_deduction', fallback: '5' },
        { key: 'fees.cancellation_threshold_hours', fallback: '4' },
        { key: 'fees.reliability_score_min', fallback: '50' },
        { key: 'fees.employer_cancel_score_deduction', fallback: '5' },
        { key: 'fees.employer_ghost_score_deduction', fallback: '10' },
        { key: 'fees.billing_block_threshold', fallback: '2' },
      ]);
    return {
      lateCancellationPenaltyFcfa: Number(penalty),
      lateCancellationScoreDeduction: Number(scoreDed),
      cancellationThresholdHours: Number(threshold),
      reliabilityScoreMin: Number(scoreMin),
      employerCancelScoreDeduction: Number(empCancel),
      employerGhostScoreDeduction: Number(empGhost),
      billingBlockThreshold: Number(billingBlock),
    };
  }

  async getContactUnlockFees() {
    const [employerFee, workerFee, expiryHours] = await this.mgetBatch([
      { key: 'fees.contact_unlock_fee_employer', fallback: '500' },
      { key: 'fees.contact_unlock_fee_worker', fallback: '100' },
      { key: 'fees.contact_unlock_expiry_hours', fallback: '48' },
    ]);
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

  async getMonetbilConfig(): Promise<{ serviceKey: string }> {
    const serviceKey = await this.get('monetbil.service_key', '');
    return { serviceKey };
  }

  /**
   * Returns a map of env-var-name → db-value for Monetbil.
   * Empty string values are omitted so the original env var takes precedence.
   */
  async getMonetbilEnvOverrides(): Promise<Record<string, string>> {
    const overrides: Record<string, string> = {};
    await Promise.all(
      Object.entries(MONETBIL_ENV_OVERRIDES).map(async ([envKey, cfgKey]) => {
        const val = await this.getRaw(cfgKey, '');
        if (val !== '') overrides[envKey] = val;
      }),
    );
    return overrides;
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
