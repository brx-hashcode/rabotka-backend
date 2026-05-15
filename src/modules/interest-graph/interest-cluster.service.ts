import { createHash } from 'node:crypto';
import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { QdrantService } from '../qdrant/qdrant.service';
import { COLLECTIONS } from '../qdrant/qdrant.config';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { InterestSignalService } from './interest-signal.service';

const VECTOR_DIM = 384;
const DEFAULT_ALPHA = 0.85;
// Signals before the profile is considered "mature" — alpha adapts below this
const ALPHA_MATURE_THRESHOLD = 10;
// Keep a tighter window — Qdrant must_not filter degrades with large arrays
const MAX_SEEN_JOB_IDS = 50;
const MAX_TRACKED_CATEGORIES = 30;

function toPointId(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface UserInterestProfile {
  positiveVectors: number[][];
  negativeVectors: number[][];
  categories: string[];
  seenJobIds: string[];
  totalSignals: number;
}

const USER_INTERESTS_COLLECTION: string = COLLECTIONS.USER_INTERESTS;

@Injectable()
export class InterestClusterService implements OnModuleInit {
  private readonly logger = new Logger(InterestClusterService.name);
  private readonly alpha = Number(
    process.env.INTEREST_GRAPH_ALPHA ?? DEFAULT_ALPHA,
  );

  constructor(
    private readonly qdrant: QdrantService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => InterestSignalService))
    private readonly signals: InterestSignalService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.qdrant.ensureDenseCollection(USER_INTERESTS_COLLECTION);
    this.logger.log(
      `User interests collection ready: ${USER_INTERESTS_COLLECTION}`,
    );
  }

  // ── EMA update — called after every signal ────────────────────────────────

  async applySignal(
    userId: string,
    jobId: string,
    jobVector: number[],
    weight: number,
    category: string | null,
  ): Promise<void> {
    const pointId = toPointId(`interest__${userId}`);

    const existing: { vector: number[]; payload: Record<string, unknown> } =
      (await this.retrievePoint(pointId)) ??
      (await this.seedFromProfile(userId, pointId));

    const signalCount = ((existing.payload.total_signals as number) ?? 0) + 1;

    // Adaptive alpha: learn faster early on, stabilize when mature
    const maturity =
      Math.min(signalCount, ALPHA_MATURE_THRESHOLD) / ALPHA_MATURE_THRESHOLD;
    const a = DEFAULT_ALPHA * maturity + 0.5 * (1 - maturity);

    const updated = existing.vector.map(
      (v, i) => a * v + (1 - a) * weight * (jobVector[i] ?? 0),
    );
    const norm = Math.sqrt(updated.reduce((s, x) => s + x * x, 0)) || 1;
    const normalized = updated.map((x) => x / norm);

    // Track seen job IDs (capped) so they can be excluded from future recommendations
    const prevSeen = isStringArray(existing.payload.seen_job_ids)
      ? existing.payload.seen_job_ids
      : [];
    const seenJobIds = [...new Set([...prevSeen, jobId])].slice(
      -MAX_SEEN_JOB_IDS,
    );

    // Track interacted categories (capped)
    const prevCats = isStringArray(existing.payload.categories)
      ? existing.payload.categories
      : [];
    const categories =
      category && !prevCats.includes(category)
        ? [...prevCats, category].slice(-MAX_TRACKED_CATEGORIES)
        : prevCats;

    await this.qdrant.upsertDense(
      USER_INTERESTS_COLLECTION,
      pointId,
      normalized,
      {
        ...existing.payload,
        user_id: userId,
        total_signals: signalCount,
        last_signal_at: new Date().toISOString(),
        seen_job_ids: seenJobIds,
        categories,
      },
    );

    this.logger.debug(
      `EMA update user=${userId} job=${jobId} w=${weight} alpha=${a.toFixed(2)} signals=${signalCount}`,
    );
  }

  // ── Profile retrieval ─────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<UserInterestProfile | null> {
    const pointId = toPointId(`interest__${userId}`);
    const point = await this.retrievePoint(pointId);
    if (!point) return null;

    const p = point.payload;
    return {
      positiveVectors: isMatrix(p.positive_vectors)
        ? p.positive_vectors
        : [point.vector],
      negativeVectors: isMatrix(p.negative_vectors) ? p.negative_vectors : [],
      categories: isStringArray(p.categories) ? p.categories : [],
      seenJobIds: isStringArray(p.seen_job_ids) ? p.seen_job_ids : [],
      totalSignals: typeof p.total_signals === 'number' ? p.total_signals : 0,
    };
  }

  // ── Public re-seed (admin / backfill) ────────────────────────────────────

  async reseedFromProfile(userId: string): Promise<void> {
    const pointId = toPointId(`interest__${userId}`);
    await this.seedFromProfile(userId, pointId);
    this.logger.log(`Re-seeded interest vector for user=${userId}`);
  }

  // ── Seed from declared profile (cold start) ───────────────────────────────

  private async seedFromProfile(
    userId: string,
    pointId: string,
  ): Promise<{ vector: number[]; payload: Record<string, unknown> }> {
    const worker = await this.prisma.profile.findUnique({
      where: { id: userId },
      select: {
        description: true,
        category: { select: { name: true } },
        categories: { select: { category: { select: { name: true } } } },
      },
    });

    const parts: string[] = [];
    if (worker?.category?.name) parts.push(worker.category.name);
    for (const pc of worker?.categories ?? []) parts.push(pc.category.name);
    if (worker?.description) parts.push(worker.description);

    const profileText = parts.filter(Boolean).join(' ').slice(0, 500);
    const vector = profileText
      ? await this.qdrant.embed(profileText)
      : Array.from<number>({ length: VECTOR_DIM }).fill(0);

    const norm = Math.sqrt(vector.reduce((s, x) => s + x * x, 0)) || 1;
    const normalized = vector.map((x) => x / norm);

    const payload: Record<string, unknown> = {
      user_id: userId,
      total_signals: 0,
      seeded_at: new Date().toISOString(),
    };

    await this.qdrant.upsertDense(
      USER_INTERESTS_COLLECTION,
      pointId,
      normalized,
      payload,
    );

    return { vector: normalized, payload };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async retrievePoint(
    pointId: string,
  ): Promise<{ vector: number[]; payload: Record<string, unknown> } | null> {
    try {
      const results = await this.qdrant
        .getClient()
        .retrieve(USER_INTERESTS_COLLECTION, {
          ids: [pointId],
          with_payload: true,
          with_vector: true,
        });
      if (!results.length) return null;

      const raw = results[0] as unknown as {
        vector?: unknown;
        payload?: Record<string, unknown> | null;
      };

      const vec = raw.vector;
      if (!isNumberArray(vec)) return null;

      return { vector: vec, payload: raw.payload ?? {} };
    } catch {
      return null;
    }
  }
}

// ── Type guards ───────────────────────────────────────────────────────────────

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'number');
}

function isMatrix(value: unknown): value is number[][] {
  return Array.isArray(value) && value.every(isNumberArray);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}
