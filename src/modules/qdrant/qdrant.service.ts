import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import Redis from 'ioredis';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../common/services/redis/redis.constants';
import { QDRANT_COLLECTION_PREFIX } from './qdrant.config';
import {
  EmbeddingModel,
  FlagEmbedding,
  SparseTextEmbedding,
  SparseEmbeddingModel,
} from 'fastembed';

export const DENSE_MODEL = EmbeddingModel.BGESmallENV15;
export const DENSE_DIM = 384;
export const SPARSE_MODEL = SparseEmbeddingModel.SpladePPEnV1;
const SEARCH_LIMIT = 30;

// Hot-path query embeddings are cached in Redis by content hash. The query
// text is deterministic per entity (a worker's profile text, a job's text),
// so encoding it on every recommendation is pure waste. `v1` namespaces the
// serialization format; bump it if the stored shape or embedding model changes.
const EMB_CACHE_PREFIX = `${REDIS_KEY_PREFIX}emb:hybrid:v1:`;
const EMB_CACHE_TTL_SECONDS = 86_400; // 24h

type HybridEmbedding = {
  dense: number[];
  sparse: { indices: number[]; values: number[] };
};

/**
 * Payload keys we filter on. Qdrant filters work without an index but degrade to
 * a full scan, so every key any `must`/`must_not` touches must be listed here.
 * Adding a key requires running `ensurePayloadIndexes` — collection creation is
 * not retroactive for collections that already exist.
 */
const INDEXED_PAYLOAD_KEYS = [
  'status',
  'categoryId',
  'categoryIds',
  'categoryName',
  'jobOfferId',
  'profileId',
  'employerId',
  'profileType',
  'amountBucket',
  // Geo. Retrieval is the only place a country constraint can actually save
  // work: scoring proximity afterwards cannot recover a candidate the vector
  // search never returned, and on the notification path an out-of-country
  // candidate costs a paid WhatsApp template rather than a wasted scroll.
  'countryCode',
  'city',
] as const;

/**
 * A retrieval hit.
 *
 * `score` is only comparable **within one call** — for hybrid search it is an
 * RRF fusion score (`Σ 1/(60+rank)`, max ≈0.033), NOT a similarity. Never put it
 * in an arithmetic expression or compare it to an absolute threshold; use `rank`
 * for fusion across sources, or `searchDenseWithFilter` when you need a
 * calibrated 0–1 similarity.
 */
export type QdrantHit = {
  id: string | number;
  score: number;
  /** 0-based position in this result set. Stable basis for rank fusion. */
  rank: number;
  payload: Record<string, unknown> | null;
};

/** Maps a Cosine distance score onto [0,1]. Vectors are normalized. */
function calibrateCosine(score: number): number {
  return Math.min(1, Math.max(0, (1 + score) / 2));
}

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
]);

/**
 * Many managed Qdrant providers drop idle TCP sockets after ~30-60s. Single
 * upserts then fail with `fetch failed` / `ECONNRESET` even though the cluster
 * is healthy — a fresh connection succeeds immediately. Retrying transient
 * network errors with a tiny backoff hides this from callers and keeps the
 * `vector_indexed_at` bookkeeping honest.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = extractErrorCode(err);
      const isTransient = code != null && TRANSIENT_ERROR_CODES.has(code);
      const isLast = i === attempts - 1;
      if (!isTransient || isLast) throw err;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  // Unreachable: loop either returns or throws.
  throw lastErr;
}

function extractErrorCode(err: unknown): string | null {
  if (err == null || typeof err !== 'object') return null;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const c = (cause as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  // Undici wraps as `TypeError: fetch failed` with the real code on .cause.
  const msg = (err as { message?: unknown }).message;
  if (typeof msg === 'string' && msg.includes('fetch failed')) {
    return 'UND_ERR_SOCKET';
  }
  return null;
}

function removeIncompleteFastembedModelDir(
  logger: Logger,
  modelDir: string,
  label: string,
): void {
  if (!fs.existsSync(modelDir)) return;
  const tokenizer = path.join(modelDir, 'tokenizer.json');
  if (fs.existsSync(tokenizer)) return;
  logger.warn(
    `Removing incomplete ${label} embedder cache (missing tokenizer.json): ${modelDir}`,
  );
  fs.rmSync(modelDir, { recursive: true, force: true });
}

function repairIncompleteFastembedCaches(
  logger: Logger,
  cacheDir: string,
): void {
  const denseDir = path.join(cacheDir, DENSE_MODEL);
  const sparseDir = path.join(cacheDir, SPARSE_MODEL.replaceAll('/', '_'));
  removeIncompleteFastembedModelDir(logger, denseDir, 'dense');
  removeIncompleteFastembedModelDir(logger, sparseDir, 'sparse');
}

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private client: QdrantClient;
  private embedder: FlagEmbedding | undefined;
  private sparseEmbedder: SparseTextEmbedding | undefined;
  private embeddersPromise: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    const url = this.config.get<string>('QDRANT_URL');
    if (!url) {
      throw new Error('QDRANT_URL is not set');
    }
    const apiKey = this.config.get<string>('QDRANT_API_KEY');
    if (!apiKey) {
      throw new Error('QDRANT_API_KEY is not set');
    }

    this.client = new QdrantClient({
      url,
      apiKey,
      checkCompatibility: false,
    });

    this.logger.log(
      `Qdrant client ready → ${url} (fastembed models load in background)`,
    );
    void this.ensureEmbedders().catch((err: unknown) => {
      this.logger.error('Fastembed initialization failed', err);
    });
  }

  private getCacheDir(): string {
    return (
      this.config.get<string>('FASTEMBED_CACHE_DIR') ??
      path.join(process.cwd(), 'local_cache')
    );
  }

  private ensureEmbedders(): Promise<void> {
    this.embeddersPromise ??= this.loadEmbedders();
    return this.embeddersPromise;
  }

  private async loadEmbedders(): Promise<void> {
    const cacheDir = this.getCacheDir();
    repairIncompleteFastembedCaches(this.logger, cacheDir);

    this.logger.log('Loading dense embedder (BGE Small EN v1.5)…');
    this.embedder = await FlagEmbedding.init({
      model: DENSE_MODEL,
      cacheDir,
    });

    this.logger.log('Loading sparse embedder (SPLADE PP En v1)…');
    this.sparseEmbedder = await SparseTextEmbedding.init({
      model: SPARSE_MODEL,
      cacheDir,
    });

    this.logger.log('Fastembed models ready');
  }

  getClient(): QdrantClient {
    return this.client;
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureEmbedders();
    const embedder = this.embedder;
    if (!embedder) {
      throw new Error('Dense embedder not initialized');
    }
    const results = embedder.embed([text]);
    const { value: batch, done } = await results[Symbol.asyncIterator]().next();
    if (done || !batch?.length) {
      throw new Error('Dense embedding produced no output');
    }
    return Array.from(batch[0]);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.ensureEmbedders();
    const embedder = this.embedder;
    if (!embedder) {
      throw new Error('Dense embedder not initialized');
    }
    const vectors: number[][] = [];
    for await (const batch of embedder.embed(texts)) {
      for (const vec of batch) {
        vectors.push(Array.from(vec));
      }
    }
    return vectors;
  }

  async sparseEmbed(
    text: string,
  ): Promise<{ indices: number[]; values: number[] }> {
    await this.ensureEmbedders();
    const sparseEmbedder = this.sparseEmbedder;
    if (!sparseEmbedder) {
      throw new Error('Sparse embedder not initialized');
    }
    const results = sparseEmbedder.embed([text]);
    const { value: batch, done } = await results[Symbol.asyncIterator]().next();
    if (done || !batch?.length) {
      throw new Error('Sparse embedding produced no output');
    }
    const sparse = batch[0];
    return {
      indices: Array.from(sparse.indices),
      values: Array.from(sparse.values),
    };
  }

  async embedHybrid(text: string): Promise<HybridEmbedding> {
    const [dense, sparse] = await Promise.all([
      this.embed(text),
      this.sparseEmbed(text),
    ]);
    return { dense, sparse };
  }

  /**
   * Query-side hybrid embedding with a Redis read-through cache keyed by the
   * text's content hash. Search queries re-encode the same deterministic text
   * (a worker/job/employer's built text) on every recommendation; caching it
   * removes that per-request fastembed cost. Same text → same vectors, so this
   * is behaviour-preserving, and it self-invalidates: edited text hashes to a
   * new key and the old one simply expires.
   *
   * Cache is strictly best-effort — any Redis/parse error falls through to a
   * direct encode so a cache problem can never fail a search. Only used on the
   * query path; indexing (`upsertHybrid`) always encodes fresh.
   */
  async embedHybridCached(text: string): Promise<HybridEmbedding> {
    const key = `${EMB_CACHE_PREFIX}${createHash('sha256').update(text).digest('hex')}`;

    try {
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached) as HybridEmbedding;
      }
    } catch (err) {
      this.logger.debug(
        `Embedding cache read failed, encoding directly: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const embedding = await this.embedHybrid(text);

    try {
      await this.redis.set(
        key,
        JSON.stringify(embedding),
        'EX',
        EMB_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.debug(
        `Embedding cache write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return embedding;
  }

  async upsertHybrid(
    collectionName: string,
    id: string,
    text: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.assertPrefix(collectionName);
    const { dense, sparse } = await this.embedHybrid(text);
    await retryTransient(() =>
      this.client.upsert(collectionName, {
        points: [
          {
            id,
            vector: {
              dense,
              sparse: { indices: sparse.indices, values: sparse.values },
            },
            payload,
          },
        ],
      }),
    );
  }

  async deletePoints(collectionName: string, ids: string[]): Promise<void> {
    this.assertPrefix(collectionName);
    await retryTransient(() =>
      this.client.delete(collectionName, { points: ids }),
    );
  }

  /**
   * Every point id in a collection, paged through with `scroll`.
   *
   * Exists so callers can reconcile the index against the source of truth —
   * nothing else can tell you a point is present that SHOULD NOT BE, because
   * search only ever surfaces what matches. Payload and vectors are left out:
   * the reconciliation only needs identity, and pulling 384-float vectors for
   * the whole collection to compare ids would be pure waste.
   */
  async listPointIds(collectionName: string): Promise<string[]> {
    this.assertPrefix(collectionName);
    const ids: string[] = [];
    let offset: string | number | undefined = undefined;

    // Bounded so a pathological collection cannot spin forever. At this page
    // size the cap is 500k points — far past anything this platform will hold,
    // and a loud warning if it is ever reached.
    for (let page = 0; page < 500; page++) {
      const res = await retryTransient(() =>
        this.client.scroll(collectionName, {
          limit: 1000,
          offset,
          with_payload: false,
          with_vector: false,
        }),
      );
      for (const point of res.points) ids.push(String(point.id));

      offset = res.next_page_offset as string | number | undefined;
      if (offset === undefined || offset === null) return ids;
    }

    this.logger.warn(
      `listPointIds(${collectionName}) hit its page cap; returning ${ids.length} ids and stopping`,
    );
    return ids;
  }

  /** Hybrid (dense+sparse RRF) search. `score` is ordinal — see {@link QdrantHit}. */
  async searchHybrid(
    collectionName: string,
    text: string,
    limit = 10,
  ): Promise<QdrantHit[]> {
    this.assertPrefix(collectionName);
    const { dense, sparse } = await this.embedHybridCached(text);
    const results = await retryTransient(() =>
      this.client.query(collectionName, {
        prefetch: [
          { query: dense, using: 'dense', limit: SEARCH_LIMIT },
          {
            query: { indices: sparse.indices, values: sparse.values },
            using: 'sparse',
            limit: SEARCH_LIMIT,
          },
        ],
        query: { fusion: 'rrf' },
        limit,
        with_payload: true,
      }),
    );
    return results.points.map((r, i) => ({
      id: r.id,
      score: r.score,
      rank: i,
      payload: r.payload as Record<string, unknown> | null,
    }));
  }

  /** Filtered hybrid search. `score` is ordinal — see {@link QdrantHit}. */
  async searchHybridWithFilter(
    collectionName: string,
    text: string,
    filter: Record<string, unknown>,
    limit = 10,
    prefetchLimit = SEARCH_LIMIT,
  ): Promise<QdrantHit[]> {
    this.assertPrefix(collectionName);
    const { dense, sparse } = await this.embedHybridCached(text);
    const results = await retryTransient(() =>
      this.client.query(collectionName, {
        prefetch: [
          { query: dense, using: 'dense', limit: prefetchLimit, filter },
          {
            query: { indices: sparse.indices, values: sparse.values },
            using: 'sparse',
            limit: prefetchLimit,
            filter,
          },
        ],
        query: { fusion: 'rrf' },
        limit,
        with_payload: true,
      }),
    );
    return results.points.map((r, i) => ({
      id: r.id,
      score: r.score,
      rank: i,
      payload: r.payload as Record<string, unknown> | null,
    }));
  }

  /**
   * Dense-only search whose `score` IS a calibrated similarity on [0,1], so it
   * can be used in arithmetic and compared to an absolute threshold. Use this
   * for the ranking stage; use the hybrid methods for candidate generation.
   */
  async searchDenseWithFilter(
    collectionName: string,
    vector: number[],
    filter: Record<string, unknown> | undefined,
    limit = 10,
  ): Promise<QdrantHit[]> {
    this.assertPrefix(collectionName);
    const results = await retryTransient(() =>
      this.client.query(collectionName, {
        query: vector,
        using: 'dense',
        ...(filter ? { filter } : {}),
        limit,
        with_payload: true,
      }),
    );
    return results.points.map((r, i) => ({
      id: r.id,
      score: calibrateCosine(r.score),
      rank: i,
      payload: r.payload as Record<string, unknown> | null,
    }));
  }

  private assertPrefix(collectionName: string): void {
    if (!collectionName.startsWith(QDRANT_COLLECTION_PREFIX)) {
      throw new Error(
        `Refusing to operate on collection "${collectionName}" — must start with "${QDRANT_COLLECTION_PREFIX}"`,
      );
    }
  }

  async ensureCollection(collectionName: string): Promise<void> {
    this.assertPrefix(collectionName);
    const collections = await retryTransient(() =>
      this.client.getCollections(),
    );
    const exists = collections.collections.some(
      (c) => c.name === collectionName,
    );
    if (exists) {
      // Indexes are not created retroactively, and an unindexed filter is a full
      // scan — so an already-existing collection still needs this pass.
      await this.ensurePayloadIndexes(collectionName);
      return;
    }

    try {
      await this.client.createCollection(collectionName, {
        vectors: {
          dense: {
            size: DENSE_DIM,
            distance: 'Cosine',
          },
        },
        sparse_vectors: {
          sparse: {
            modifier: 'idf',
          },
        },
      });
      this.logger.log(`Collection created: ${collectionName}`);
    } catch (err: any) {
      if (err?.status === 409) {
        // already exists — concurrent creation race
        await this.ensurePayloadIndexes(collectionName);
        return;
      }
      throw err;
    }
    await this.ensurePayloadIndexes(collectionName);
  }

  /**
   * Creates a keyword payload index per filterable key. Idempotent — Qdrant
   * returns 409 for an index that already exists, which we swallow. Best-effort:
   * a failure here degrades performance, never correctness, so it must not break
   * indexing or search.
   */
  async ensurePayloadIndexes(collectionName: string): Promise<void> {
    this.assertPrefix(collectionName);
    for (const field of INDEXED_PAYLOAD_KEYS) {
      try {
        await this.client.createPayloadIndex(collectionName, {
          field_name: field,
          field_schema: 'keyword',
        });
      } catch (err: unknown) {
        const status = (err as { status?: number } | null)?.status;
        if (status === 409 || status === 400) continue; // exists / not present in payload
        this.logger.warn(
          `Payload index for "${field}" on ${collectionName} failed`,
          err,
        );
      }
    }
  }

  async ensureDenseCollection(collectionName: string): Promise<void> {
    this.assertPrefix(collectionName);
    const collections = await retryTransient(() =>
      this.client.getCollections(),
    );
    const exists = collections.collections.some(
      (c) => c.name === collectionName,
    );
    if (exists) return;

    try {
      await this.client.createCollection(collectionName, {
        vectors: {
          dense: { size: DENSE_DIM, distance: 'Cosine' },
        },
      });
      this.logger.log(`Dense collection created: ${collectionName}`);
    } catch (err: any) {
      if (err?.status === 409) return; // already exists — concurrent creation race
      throw err;
    }
  }

  async upsertDense(
    collectionName: string,
    id: string,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    this.assertPrefix(collectionName);
    await retryTransient(() =>
      this.client.upsert(collectionName, {
        points: [{ id, vector: { dense: vector }, payload }],
      }),
    );
  }

  async recommendDense(
    collectionName: string,
    positiveVectors: number[][],
    negativeVectors: number[][],
    filter: Record<string, unknown> | undefined,
    limit: number,
  ): Promise<
    Array<{
      id: string | number;
      score: number;
      payload: Record<string, unknown> | null;
    }>
  > {
    this.assertPrefix(collectionName);
    const results = await retryTransient(() =>
      this.client.query(collectionName, {
        query: {
          recommend: {
            positive: positiveVectors,
            negative: negativeVectors,
            strategy: 'average_vector',
          },
        },
        using: 'dense',
        filter,
        limit,
        with_payload: true,
      }),
    );
    return results.points.map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload as Record<string, unknown> | null,
    }));
  }
}
