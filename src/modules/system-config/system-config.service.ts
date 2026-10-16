import {
  WHATSAPP_NOTIFICATION_GROUPS,
  whatsAppNotificationKey,
  type WhatsAppNotificationGroup,
} from '../notification-dispatch/whatsapp-notification-groups';
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

const EMBEDDINGS_KEY = 'matching.use_embeddings';
const EMBEDDINGS_ENABLED_AT_KEY = 'matching.embeddings_enabled_at';
const INDEX_SCHEMA_VERSION_KEY = 'matching.index_schema_version';
const SEED_MAX_RETRIES = 10;
const SEED_RETRY_DELAY_MS = 2000;

/**
 * The parrainage block, named because it is validated as a block.
 *
 * `commission_type` decides what unit the two credit values are in, and the two
 * percentages have to sum to at most 100 — neither rule can be checked one key
 * at a time, which is why {@link SystemConfigService.setMany} exists.
 */
const REFERRAL_COMMISSION_TYPE_KEY = 'fees.referral_commission_type';
const REFERRAL_CREDIT_REFERRER_KEY = 'fees.referral_credit_referrer';
const REFERRAL_CREDIT_REFEREE_KEY = 'fees.referral_credit_referee';
const REFERRAL_MAX_REWARDED_KEY = 'fees.referral_max_rewarded_per_referrer';
const REFERRAL_MAX_PAYOUT_KEY = 'fees.referral_max_payout_per_referral';

const REFERRAL_DEFAULTS: Record<string, string> = {
  [REFERRAL_COMMISSION_TYPE_KEY]: 'FIXED',
  [REFERRAL_CREDIT_REFERRER_KEY]: '300',
  [REFERRAL_CREDIT_REFEREE_KEY]: '200',
  [REFERRAL_MAX_REWARDED_KEY]: '10',
  [REFERRAL_MAX_PAYOUT_KEY]: '0',
};

const REFERRAL_COMMISSION_TYPES = ['FIXED', 'PERCENTAGE'] as const;
const MAX_PERCENT = 100;

const AGENT_COMMISSION_AMOUNT_KEY = 'agent.commission_per_placement_fcfa';
const AGENT_COMMISSION_RELEASE_EVENTS = ['UNLOCKED', 'COMPLETED'] as const;
const AGENT_COMMISSION_MULTI_SEAT_MODES = [
  'PER_PLACEMENT',
  'FIRST_ONLY',
] as const;

export type AgentCommissionSettings = {
  amountFcfa: number;
  /** What starts the confirmation window. */
  releaseEvent: (typeof AGENT_COMMISSION_RELEASE_EVENTS)[number];
  confirmationHours: number;
  requiresMomoWorker: boolean;
  requiresMomoEmployer: boolean;
  multiSeatMode: (typeof AGENT_COMMISSION_MULTI_SEAT_MODES)[number];
};

/**
 * Fan-out width when the config says nothing. Kept in step with the seeded
 * value of `matching.max_notification_workers`.
 */
const DEFAULT_MAX_NOTIFICATION_WORKERS = 5;

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
    'fees.penalty_suspension_threshold',
    'fees.cancellation_suspension_count',
    'fees.cancellation_suspension_window_days',
    'fees.penalty_hard_block_days',
    'fees.penalty_max_notifications',
    'fees.penalty_notification_interval_hours',
    'fees.max_daily_applications',
    'fees.contact_unlock_fee_employer',
    'fees.contact_unlock_fee_worker',
    'fees.contact_unlock_expiry_hours',
    'fees.contact_recommendation_fee_employer',
    'fees.welcome_credit_worker',
    'fees.welcome_credit_employer',
    'matching.max_notification_workers',
    'matching.pair_cancel_decay_days',
    'agent.phone_reveal_daily_cap',
    'agent.lead_claim_hours',
    'agent.invite_expiry_hours',
    'agent.withdrawal_min_fcfa',
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
    'matching.pair_cancel_penalty',
    'agent.candidate_min_score',
  ]);

  /**
   * Counts that are allowed to be zero, where zero means "off" rather than
   * "broken" — an unlimited cap, an absent ceiling. They cannot live in
   * {@link POSITIVE_INT_KEYS} for that reason, but they still must not be
   * negative or unparseable.
   */
  private static readonly NON_NEGATIVE_INT_KEYS = new Set([
    REFERRAL_MAX_REWARDED_KEY,
    REFERRAL_MAX_PAYOUT_KEY,
    // 0 = commissions off.
    AGENT_COMMISSION_AMOUNT_KEY,
    // 0 = withdrawable as soon as the release event happens.
    'agent.commission_confirmation_hours',
    // 0 = only late cancellations cost reliability points.
    'fees.cancellation_score_deduction',
  ]);

  /** Keys whose value is one of a fixed set; anything else is refused. */
  private static readonly CHOICE_KEYS: Record<string, readonly string[]> = {
    'agent.commission_release_event': AGENT_COMMISSION_RELEASE_EVENTS,
    'agent.commission_multi_seat_mode': AGENT_COMMISSION_MULTI_SEAT_MODES,
    'agent.commission_requires_momo_worker': ['true', 'false'],
    'agent.commission_requires_momo_employer': ['true', 'false'],
    'agent.invite_whatsapp_enabled': ['true', 'false'],
    ...Object.fromEntries(
      (
        Object.keys(WHATSAPP_NOTIFICATION_GROUPS) as WhatsAppNotificationGroup[]
      ).map((group) => [whatsAppNotificationKey(group), ['true', 'false']]),
    ),
  };

  async set(key: string, value: string, adminId?: string): Promise<void> {
    await this.setMany({ [key]: value }, adminId);
  }

  /**
   * Write several config values as one unit.
   *
   * Exists because some rules span keys. `fees.referral_commission_type`
   * decides whether the two credit values are francs or percentages, and in
   * PERCENTAGE mode they must sum to at most 100 — so switching from 300/200
   * FCFA to 60/40 % is three writes that are each invalid on their own and only
   * coherent together. One key at a time can either reject the admin's whole
   * intent or persist a state the settlement cannot honour; neither is
   * acceptable for a screen that pays people money.
   *
   * Validated as a set against the state the write would PRODUCE, then applied
   * in a single transaction so a mid-way failure leaves nothing half-changed.
   */
  async setMany(
    updates: Record<string, string>,
    adminId?: string,
  ): Promise<void> {
    const entries = Object.entries(updates);
    if (entries.length === 0) {
      throw new BadRequestException('Aucune valeur à mettre à jour');
    }

    for (const [key, value] of entries) {
      SystemConfigService.assertValueValid(key, value);
    }
    await this.assertReferralBlockCoherent(updates);
    await this.assertAgentCommissionBelowFees(updates);

    // Read before writing: the stamp below is driven by the TRANSITION, not by
    // the new value, so re-saving `true` over `true` must not move it. Moving it
    // would push the timestamp past every `vector_indexed_at` written since the
    // real activation and strand exactly the rows the stamp exists to reclaim.
    const wasEnabled =
      EMBEDDINGS_KEY in updates ? await this.isSimilarityEnabled() : false;

    // Array form: one transaction, and an unknown key fails it as P2025 with
    // nothing committed, so a typo cannot half-apply a settings save.
    await this.prisma.$transaction(
      entries.map(([key, value]) =>
        this.prisma.systemConfig.update({
          where: { key },
          data: { value, updated_by: adminId ?? null },
        }),
      ),
    );

    await this.redis.del(...entries.map(([key]) => `${CACHE_PREFIX}${key}`));
    this.logger.log(
      `Config updated: ${entries.map(([k]) => k).join(', ')} by ${adminId ?? 'system'}`,
    );

    if (!wasEnabled && updates[EMBEDDINGS_KEY] === 'true') {
      await this.markEmbeddingsEnabled();
    }
  }

  /** Rules that need only the one value being written. */
  private static assertValueValid(key: string, value: string): void {
    if (SystemConfigService.POSITIVE_INT_KEYS.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new BadRequestException(
          `La valeur de "${key}" doit être un entier strictement positif`,
        );
      }
    }
    if (SystemConfigService.NON_NEGATIVE_INT_KEYS.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        throw new BadRequestException(
          `La valeur de "${key}" doit être un entier positif ou nul`,
        );
      }
    }
    const choices = SystemConfigService.CHOICE_KEYS[key];
    if (choices && !choices.includes(value)) {
      throw new BadRequestException(
        `La valeur de "${key}" doit être ${choices.join(' ou ')}`,
      );
    }
    if (SystemConfigService.UNIT_INTERVAL_KEYS.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new BadRequestException(
          `La valeur de "${key}" doit être un nombre entre 0 et 1`,
        );
      }
    }
  }

  /**
   * An agent's commission is paid out of what the placement brought in — the
   * two contact-unlock fees — so it must stay below their sum, or Rabotka pays
   * to place people. Checked against the state the write would leave, like
   * the parrainage block, and only when it touches one of the three values.
   */
  private async assertAgentCommissionBelowFees(
    updates: Record<string, string>,
  ): Promise<void> {
    const keys = [
      AGENT_COMMISSION_AMOUNT_KEY,
      'fees.contact_unlock_fee_employer',
      'fees.contact_unlock_fee_worker',
    ];
    if (!keys.some((key) => key in updates)) return;

    const stored = await this.mgetBatch([
      { key: AGENT_COMMISSION_AMOUNT_KEY, fallback: '400' },
      { key: 'fees.contact_unlock_fee_employer', fallback: '500' },
      { key: 'fees.contact_unlock_fee_worker', fallback: '100' },
    ]);
    const [commission, employerFee, workerFee] = keys.map((key, i) =>
      Number(updates[key] ?? stored[i]),
    );
    if (commission > 0 && commission >= employerFee + workerFee) {
      throw new BadRequestException(
        `La commission de l'agent (${commission} FCFA) doit rester inférieure au total des frais de déverrouillage (${employerFee + workerFee} FCFA)`,
      );
    }
  }

  /**
   * Rules that need the whole parrainage block, checked against the state this
   * write would leave behind — the incoming values laid over what is stored.
   *
   * Skipped entirely when the write touches none of those keys, so an unrelated
   * config save does not pay for a read of them.
   */
  private async assertReferralBlockCoherent(
    updates: Record<string, string>,
  ): Promise<void> {
    const blockKeys = Object.keys(REFERRAL_DEFAULTS);
    if (!blockKeys.some((key) => key in updates)) return;

    const missing = blockKeys.filter((key) => !(key in updates));
    const stored = await this.mgetBatch(
      missing.map((key) => ({ key, fallback: REFERRAL_DEFAULTS[key] })),
    );
    const resulting: Record<string, string> = { ...updates };
    missing.forEach((key, i) => {
      resulting[key] = stored[i] ?? REFERRAL_DEFAULTS[key];
    });

    const type = resulting[REFERRAL_COMMISSION_TYPE_KEY];
    if (!REFERRAL_COMMISSION_TYPES.includes(type as 'FIXED')) {
      throw new BadRequestException(
        `La valeur de "${REFERRAL_COMMISSION_TYPE_KEY}" doit être ${REFERRAL_COMMISSION_TYPES.join(' ou ')}`,
      );
    }

    const referrer = Number(resulting[REFERRAL_CREDIT_REFERRER_KEY]);
    const referee = Number(resulting[REFERRAL_CREDIT_REFEREE_KEY]);
    for (const [key, n] of [
      [REFERRAL_CREDIT_REFERRER_KEY, referrer],
      [REFERRAL_CREDIT_REFEREE_KEY, referee],
    ] as const) {
      if (!Number.isFinite(n) || n < 0) {
        throw new BadRequestException(
          `La valeur de "${key}" doit être un nombre positif ou nul`,
        );
      }
    }

    if (type !== 'PERCENTAGE') return;

    // Percentages only. A pair summing past 100 would try to pay out more than
    // the payment brought in; the payout function clamps it anyway, but silently
    // paying something other than what the screen says is worse than refusing
    // the save.
    for (const [key, n] of [
      [REFERRAL_CREDIT_REFERRER_KEY, referrer],
      [REFERRAL_CREDIT_REFEREE_KEY, referee],
    ] as const) {
      if (!Number.isInteger(n) || n > MAX_PERCENT) {
        throw new BadRequestException(
          `En mode PERCENTAGE, "${key}" doit être un entier entre 0 et ${MAX_PERCENT}`,
        );
      }
    }
    if (referrer + referee > MAX_PERCENT) {
      throw new BadRequestException(
        `La somme des pourcentages de parrainage ne peut pas dépasser ${MAX_PERCENT} % (reçu ${referrer + referee} %)`,
      );
    }
  }

  /**
   * Records when embeddings came back on, so `MatchingService.reindexPending`
   * can tell a genuine index from the bookkeeping stamp written while the
   * feature was off.
   *
   * Upserted rather than updated: a database seeded before this key existed has
   * no row, and a missing row must not turn re-enabling embeddings into a 500.
   * Best-effort for the same reason — the admin's config write has already
   * succeeded by the time this runs, so a failure here is logged and swallowed
   * rather than rolled back onto the caller.
   */
  private async markEmbeddingsEnabled(): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.prisma.systemConfig.upsert({
        where: { key: EMBEDDINGS_ENABLED_AT_KEY },
        update: { value: now },
        create: {
          key: EMBEDDINGS_ENABLED_AT_KEY,
          value: now,
          category: ConfigCategory.MATCHING,
          label: 'Dernière activation des embeddings (ISO, automatique)',
          is_secret: false,
        },
      });
      await this.redis.del(`${CACHE_PREFIX}${EMBEDDINGS_ENABLED_AT_KEY}`);
      this.logger.log(
        `Embeddings enabled at ${now} — pending re-index widened`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to record ${EMBEDDINGS_ENABLED_AT_KEY}; re-index will not reclaim stamped rows until embeddings are toggled again`,
        err,
      );
    }
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
    const val = await this.get(EMBEDDINGS_KEY, 'false');
    return val === 'true';
  }

  /**
   * The payload schema version the index was last fully rewritten at, or null if
   * it has never been recorded.
   *
   * Null is the honest answer for a database predating this key, and it makes
   * `reindexPending` rewrite everything once — which is exactly right, since a
   * pre-existing index cannot have the fields added since.
   */
  async getIndexSchemaVersion(): Promise<number | null> {
    const val = (await this.get(INDEX_SCHEMA_VERSION_KEY, '')).trim();
    if (!val) return null;
    const parsed = Number(val);
    if (!Number.isInteger(parsed) || parsed < 0) {
      this.logger.warn(
        `Ignoring unparseable ${INDEX_SCHEMA_VERSION_KEY}: "${val}"`,
      );
      return null;
    }
    return parsed;
  }

  /** Records a completed full rewrite. Upserted for the same reason as the stamp. */
  async setIndexSchemaVersion(version: number): Promise<void> {
    try {
      await this.prisma.systemConfig.upsert({
        where: { key: INDEX_SCHEMA_VERSION_KEY },
        update: { value: String(version) },
        create: {
          key: INDEX_SCHEMA_VERSION_KEY,
          value: String(version),
          category: ConfigCategory.MATCHING,
          label: 'Version du schéma de payload Qdrant (automatique)',
          is_secret: false,
        },
      });
      await this.redis.del(`${CACHE_PREFIX}${INDEX_SCHEMA_VERSION_KEY}`);
    } catch (err) {
      // Leaves the version behind, so the next scan repeats the wide pass.
      // Wasteful, never wrong — the alternative is claiming a migration that
      // did not happen and letting filters run against a stale payload.
      this.logger.error(
        `Failed to record ${INDEX_SCHEMA_VERSION_KEY}=${version}; the next scan will rewrite the index again`,
        err,
      );
    }
  }

  /**
   * When embeddings were last switched on, or null if never.
   *
   * `reindexPending` treats any `vector_indexed_at` older than this as a
   * bookkeeping stamp rather than a real index — see `markEmbeddingsEnabled`.
   * Returns null on an unparseable value so a corrupt row degrades to the old
   * null-only behaviour instead of matching every row on every scan.
   */
  async getEmbeddingsEnabledAt(): Promise<Date | null> {
    const val = (await this.get(EMBEDDINGS_ENABLED_AT_KEY, '')).trim();
    if (!val) return null;
    const parsed = new Date(val);
    if (Number.isNaN(parsed.getTime())) {
      this.logger.warn(
        `Ignoring unparseable ${EMBEDDINGS_ENABLED_AT_KEY}: "${val}"`,
      );
      return null;
    }
    return parsed;
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

  /**
   * How many workers one offer may notify.
   *
   * The fallback matches the seeded default on purpose: a missing or malformed
   * key must not quietly widen the fan-out, which is the failure mode that
   * costs real money and a WhatsApp quality rating.
   */
  async getMaxNotificationWorkers(): Promise<number> {
    const val = await this.get(
      'matching.max_notification_workers',
      String(DEFAULT_MAX_NOTIFICATION_WORKERS),
    );
    const n = Number.parseInt(val, 10);
    return Number.isNaN(n) || n < 1 ? DEFAULT_MAX_NOTIFICATION_WORKERS : n;
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

  /**
   * Minimum minutes between two "someone applied" notifications for the SAME
   * offer.
   *
   * Without it a popular offer sends the employer one billed template per
   * applicant, in real time — twenty-five candidates, twenty-five messages,
   * all pointing at the same page. The notification is a nudge, not the
   * channel: its button opens the offer, where every applicant is listed. So
   * pacing it costs the employer nothing they cannot see one tap later.
   *
   * `0` disables the pacing and restores a message per application, which is
   * the escape hatch if this ever proves too quiet.
   *
   * Filed under MATCHING because that is where the sibling recommendation
   * cooldown lives and where an operator looks for notification pacing — the
   * category enum has no better home, and adding one costs a migration.
   */
  async getNewApplicationNotifyCooldownMinutes(): Promise<number> {
    const val = await this.get(
      'matching.new_application_notify_cooldown_minutes',
      '30',
    );
    const n = Number.parseInt(val, 10);
    return Number.isNaN(n) || n < 0 ? 30 : n;
  }

  /**
   * Estimated cost of one MARKETING template, in FCFA.
   *
   * Only ever used to show an admin what a broadcast is about to cost. It is
   * deliberately an estimate: Meta bills per conversation in USD at a rate that
   * moves. A number that is roughly right lets someone judge a send before
   * confirming it; no number at all means confirming blind.
   */
  async getMarketingTemplateCostFcfa(): Promise<number> {
    const val = await this.get('fees.marketing_template_cost_fcfa', '15');
    const n = Number.parseInt(val, 10);
    return Number.isNaN(n) || n < 0 ? 15 : n;
  }

  /**
   * Whether a notification may go out as free-form text when the 24h window is
   * open, instead of as its approved template.
   *
   * Defaults to TRUE, unlike most switches here, because the safe direction is
   * the cheap one: the free-form path falls back to the very template it
   * replaced on any failure, so the worst case is the behaviour this key turns
   * off. See the note on the key in `system-config.constants.ts`.
   */
  async prefersFreeForm(): Promise<boolean> {
    const val = await this.get('notifications.prefer_free_form', 'true');
    return val === 'true';
  }

  /**
   * How many unread profile views a worker may pile up before WhatsApp tells
   * them. `0` turns the reminder off.
   */
  async getProfileViewsWhatsAppThreshold(): Promise<number> {
    const val = await this.get(
      'notifications.profile_views_whatsapp_threshold',
      '5',
    );
    const n = Number.parseInt(val, 10);
    return Number.isNaN(n) || n < 0 ? 5 : n;
  }

  async getProfileViewsWhatsAppCooldownHours(): Promise<number> {
    const val = await this.get(
      'notifications.profile_views_whatsapp_cooldown_hours',
      '168',
    );
    const n = Number.parseInt(val, 10);
    return Number.isNaN(n) || n < 1 ? 168 : n;
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
      suspensionThreshold,
      hardBlockDays,
      maxDailyApps,
      completionReward,
      ratingDelta1,
      ratingDelta2,
      ratingDelta3,
      ratingDelta4,
      ratingDelta5,
      cancelSuspensionCount,
      cancelSuspensionWindowDays,
      cancelScoreDeduction,
    ] = await this.mgetBatch([
      { key: 'fees.late_cancellation_penalty_fcfa', fallback: '5000' },
      { key: 'fees.late_cancellation_score_deduction', fallback: '5' },
      { key: 'fees.cancellation_threshold_hours', fallback: '4' },
      { key: 'fees.reliability_score_min', fallback: '50' },
      { key: 'fees.employer_late_cancel_score_deduction', fallback: '5' },
      { key: 'fees.billing_block_threshold', fallback: '2' },
      { key: 'fees.penalty_suspension_threshold', fallback: '3' },
      { key: 'fees.penalty_hard_block_days', fallback: '3' },
      { key: 'fees.max_daily_applications', fallback: '10' },
      { key: 'fees.completion_score_reward', fallback: '1' },
      { key: 'fees.rating_score_delta_1', fallback: '-4' },
      { key: 'fees.rating_score_delta_2', fallback: '-2' },
      { key: 'fees.rating_score_delta_3', fallback: '0' },
      { key: 'fees.rating_score_delta_4', fallback: '1' },
      { key: 'fees.rating_score_delta_5', fallback: '3' },
      { key: 'fees.cancellation_suspension_count', fallback: '3' },
      { key: 'fees.cancellation_suspension_window_days', fallback: '30' },
      { key: 'fees.cancellation_score_deduction', fallback: '0' },
    ]);
    return {
      lateCancellationPenaltyFcfa: Number(penalty),
      lateCancellationScoreDeduction: Number(scoreDed),
      cancellationThresholdHours: Number(threshold),
      reliabilityScoreMin: Number(scoreMin),
      employerLateCancelScoreDeduction: Number(empLateCancelDed),
      billingBlockThreshold: Number(billingBlock),
      // Suspension is strictly harsher than a billing block, so it can never
      // fire first. Clamping here rather than at write time keeps an existing
      // bad pair (or a hand-edited row) from inverting the ladder.
      penaltySuspensionThreshold: Math.max(
        Number(suspensionThreshold),
        Number(billingBlock),
      ),
      penaltyHardBlockDays: Number(hardBlockDays),
      maxDailyApplications: Number(maxDailyApps),
      completionScoreReward: Number(completionReward),
      ratingScoreDeltas: {
        1: Number(ratingDelta1),
        2: Number(ratingDelta2),
        3: Number(ratingDelta3),
        4: Number(ratingDelta4),
        5: Number(ratingDelta5),
      } as Record<number, number>,
      cancellationSuspensionCount: Number(cancelSuspensionCount),
      cancellationSuspensionWindowDays: Number(cancelSuspensionWindowDays),
      cancellationScoreDeduction: Number(cancelScoreDeduction),
    };
  }

  /**
   * The reminder cadence for an unpaid penalty, and the window it runs for.
   *
   * Separate from `getFees()` because the hourly scan needs three keys, not
   * fifteen. `hardBlockDays` is the same key `getFees` exposes as
   * `penaltyHardBlockDays`: past that point the account is hard-blocked and
   * reminding it further is pointless, so the scan stops there.
   */
  async getPenaltyNotificationConfig() {
    const [maxNotifications, intervalHours, hardBlockDays] =
      await this.mgetBatch([
        { key: 'fees.penalty_max_notifications', fallback: '3' },
        { key: 'fees.penalty_notification_interval_hours', fallback: '23' },
        { key: 'fees.penalty_hard_block_days', fallback: '3' },
      ]);
    return {
      maxNotifications: Number(maxNotifications),
      notificationIntervalHours: Number(intervalHours),
      hardBlockDays: Number(hardBlockDays),
    };
  }

  async getPenaltyHardBlockDays(): Promise<number> {
    return Number(await this.get('fees.penalty_hard_block_days', '3'));
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

  /** The field-agent pipeline settings, read together by the lead service. */
  async getAgentLeadSettings(): Promise<{
    revealDailyCap: number;
    claimHours: number;
    inviteExpiryHours: number;
  }> {
    const [cap, claim, invite] = await Promise.all([
      this.get('agent.phone_reveal_daily_cap', '30'),
      this.get('agent.lead_claim_hours', '24'),
      this.get('agent.invite_expiry_hours', '48'),
    ]);
    const int = (v: string, d: number) => {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : d;
    };
    return {
      revealDailyCap: int(cap, 30),
      claimHours: int(claim, 24),
      inviteExpiryHours: int(invite, 48),
    };
  }

  /** Whether an agent's invitation is sent to the worker by WhatsApp. */
  async isAgentInviteWhatsAppEnabled(): Promise<boolean> {
    return (
      (await this.get('agent.invite_whatsapp_enabled', 'false')) === 'true'
    );
  }

  /** The smallest withdrawal an agent may request, in FCFA. */
  async getAgentWithdrawalMinFcfa(): Promise<number> {
    const raw = await this.get('agent.withdrawal_min_fcfa', '2000');
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 2000;
  }

  /** The rules a placement's commission is decided and released by. */
  async getAgentCommissionSettings(): Promise<AgentCommissionSettings> {
    const [amount, event, hours, momoWorker, momoEmployer, multiSeat] =
      await this.mgetBatch([
        { key: AGENT_COMMISSION_AMOUNT_KEY, fallback: '400' },
        { key: 'agent.commission_release_event', fallback: 'UNLOCKED' },
        { key: 'agent.commission_confirmation_hours', fallback: '72' },
        { key: 'agent.commission_requires_momo_worker', fallback: 'true' },
        { key: 'agent.commission_requires_momo_employer', fallback: 'true' },
        { key: 'agent.commission_multi_seat_mode', fallback: 'PER_PLACEMENT' },
      ]);
    const nonNegative = (v: string | null, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : d;
    };
    return {
      amountFcfa: nonNegative(amount, 400),
      releaseEvent: event === 'COMPLETED' ? 'COMPLETED' : 'UNLOCKED',
      confirmationHours: nonNegative(hours, 72),
      // Anything but an explicit "false" keeps the safer rule on.
      requiresMomoWorker: momoWorker !== 'false',
      requiresMomoEmployer: momoEmployer !== 'false',
      multiSeatMode:
        multiSeat === 'FIRST_ONLY' ? 'FIRST_ONLY' : 'PER_PLACEMENT',
    };
  }

  /** Threshold for the agent app's suggested workers — see the seeded key. */
  async getAgentCandidateMinScore(): Promise<number> {
    const val = await this.get('agent.candidate_min_score', '0.3');
    const n = Number(val);
    return Number.isFinite(n) ? n : 0.3;
  }

  async getRecommendationMinScore(): Promise<number> {
    const val = await this.get('matching.recommendation_min_score', '0.3');
    const n = Number(val);
    return Number.isFinite(n) ? n : 0.3;
  }

  /**
   * How much one worker cancellation lowers that worker's compatibility with
   * that employer (`strength`, 0–1), and over how many days it fades out.
   */
  async getPairCancellationPenalty(): Promise<{
    strength: number;
    decayDays: number;
  }> {
    const [strength, decayDays] = await this.mgetBatch([
      { key: 'matching.pair_cancel_penalty', fallback: '0.25' },
      { key: 'matching.pair_cancel_decay_days', fallback: '180' },
    ]);
    const s = Number(strength);
    const d = Number(decayDays);
    return {
      strength: Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0.25,
      decayDays: Number.isFinite(d) && d > 0 ? d : 180,
    };
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

  /**
   * Parrainage payout amounts and the per-parrain cap.
   *
   * `maxRewardedPerReferrer` is `null` for unlimited, not `0`. The config value
   * uses 0 as the "no cap" sentinel because that reads better in the admin
   * screen than an empty field, but letting that 0 reach a call site produces
   * `rewardedCount >= 0` — a cap that rejects everyone, silently, and only for
   * the admins who deliberately turned it off. Resolve it here, once.
   */
  /**
   * The parrainage settings, as one read.
   *
   * `referrerCreditFcfa` / `refereeCreditFcfa` are francs when
   * `commissionType` is FIXED and percentages when it is PERCENTAGE — the name
   * keeps the FCFA suffix because the storage keys do, and renaming them would
   * churn every call site to describe a unit that is already carried by the
   * type beside them.
   */
  async getReferralCredits(): Promise<{
    commissionType: 'FIXED' | 'PERCENTAGE';
    referrerCreditFcfa: number;
    refereeCreditFcfa: number;
    maxRewardedPerReferrer: number | null;
    maxPayoutPerReferralFcfa: number;
  }> {
    const [referrerCredit, refereeCredit, maxRewarded, type, maxPayout] =
      await this.mgetBatch([
        {
          key: REFERRAL_CREDIT_REFERRER_KEY,
          fallback: REFERRAL_DEFAULTS[REFERRAL_CREDIT_REFERRER_KEY],
        },
        {
          key: REFERRAL_CREDIT_REFEREE_KEY,
          fallback: REFERRAL_DEFAULTS[REFERRAL_CREDIT_REFEREE_KEY],
        },
        {
          key: REFERRAL_MAX_REWARDED_KEY,
          fallback: REFERRAL_DEFAULTS[REFERRAL_MAX_REWARDED_KEY],
        },
        {
          key: REFERRAL_COMMISSION_TYPE_KEY,
          fallback: REFERRAL_DEFAULTS[REFERRAL_COMMISSION_TYPE_KEY],
        },
        {
          key: REFERRAL_MAX_PAYOUT_KEY,
          fallback: REFERRAL_DEFAULTS[REFERRAL_MAX_PAYOUT_KEY],
        },
      ]);

    const cap = Number(maxRewarded);
    const ceiling = Number(maxPayout);
    return {
      // Anything unrecognised reads as FIXED. A database row that says
      // something else is a bug, and the safe reading of a broken type is the
      // one whose amounts an admin explicitly typed rather than one that
      // reinterprets 300 as 300 %.
      commissionType: type === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED',
      referrerCreditFcfa: Number(referrerCredit),
      refereeCreditFcfa: Number(refereeCredit),
      maxRewardedPerReferrer:
        !Number.isFinite(cap) || cap <= 0 ? null : Math.floor(cap),
      maxPayoutPerReferralFcfa:
        !Number.isFinite(ceiling) || ceiling <= 0 ? 0 : Math.floor(ceiling),
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
