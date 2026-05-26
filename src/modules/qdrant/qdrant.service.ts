import * as fs from 'node:fs';
import * as path from 'node:path';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
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
async function retryTransient<T>(
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

  constructor(private readonly config: ConfigService) {}

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

  async embedHybrid(text: string): Promise<{
    dense: number[];
    sparse: { indices: number[]; values: number[] };
  }> {
    const [dense, sparse] = await Promise.all([
      this.embed(text),
      this.sparseEmbed(text),
    ]);
    return { dense, sparse };
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

  async searchHybrid(
    collectionName: string,
    text: string,
    limit = 10,
  ): Promise<
    Array<{
      id: string | number;
      score: number;
      payload: Record<string, unknown> | null;
    }>
  > {
    this.assertPrefix(collectionName);
    const { dense, sparse } = await this.embedHybrid(text);
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
    return results.points.map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload as Record<string, unknown> | null,
    }));
  }

  async searchHybridWithFilter(
    collectionName: string,
    text: string,
    filter: Record<string, unknown>,
    limit = 10,
    prefetchLimit = SEARCH_LIMIT,
  ): Promise<
    Array<{
      id: string | number;
      score: number;
      payload: Record<string, unknown> | null;
    }>
  > {
    this.assertPrefix(collectionName);
    const { dense, sparse } = await this.embedHybrid(text);
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
    return results.points.map((r) => ({
      id: r.id,
      score: r.score,
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
    if (exists) return;

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
      if (err?.status === 409) return; // already exists — concurrent creation race
      throw err;
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
