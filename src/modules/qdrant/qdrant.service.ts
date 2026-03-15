import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  EmbeddingModel,
  FlagEmbedding,
  SparseEmbeddingModel,
  SparseTextEmbedding,
} from 'fastembed';
import type { SparseVector } from 'fastembed';

export type { SparseVector } from 'fastembed';

export const DENSE_DIM = 384;
export const DENSE_MODEL = EmbeddingModel.BGESmallENV15;
export const SPARSE_MODEL = SparseEmbeddingModel.SpladePPEnV1;

export const COLLECTION_PROFILES = 'profiles';
export const COLLECTION_JOB_OFFERS = 'job_offers';

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private client: QdrantClient;
  private embedder: FlagEmbedding;
  private sparseEmbedder: SparseTextEmbedding | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('QDRANT_URL', 'http://localhost:6333');
    const apiKey = this.config.get<string>('QDRANT_API_KEY');

    this.client = new QdrantClient({ url, apiKey });

    this.embedder = await FlagEmbedding.init({
      model: DENSE_MODEL,
    });

    this.logger.log(`Qdrant client initialized → ${url}`);
  }

  private async getSparseEmbedder(): Promise<SparseTextEmbedding> {
    this.sparseEmbedder ??= await SparseTextEmbedding.init({
      model: SPARSE_MODEL,
    });
    return this.sparseEmbedder;
  }

  getClient(): QdrantClient {
    return this.client;
  }

  /**
   * Embed a single text string into a dense vector (384-dim).
   */
  async embed(text: string): Promise<number[]> {
    const results = this.embedder.embed([text]);
    const { value: batch, done } = await results[Symbol.asyncIterator]().next();
    if (done || !batch?.length) {
      throw new Error('Embedding produced no output');
    }
    return Array.from(batch[0]);
  }

  /**
   * Embed multiple texts at once.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    const results = this.embedder.embed(texts);
    for await (const batch of results) {
      for (const vec of batch) {
        vectors.push(Array.from(vec));
      }
    }
    return vectors;
  }

  /**
   * Embed a single text into a sparse vector (for hybrid search).
   */
  async embedSparse(text: string): Promise<SparseVector> {
    const embedder = await this.getSparseEmbedder();
    return embedder.queryEmbed(text);
  }

  /**
   * Embed multiple texts into sparse vectors at once.
   */
  async embedSparseBatch(texts: string[]): Promise<SparseVector[]> {
    const embedder = await this.getSparseEmbedder();
    const vectors: SparseVector[] = [];
    const results = embedder.embed(texts);
    for await (const batch of results) {
      for (const v of batch) {
        vectors.push({ indices: [...v.indices], values: [...v.values] });
      }
    }
    return vectors;
  }

  /**
   * Ensure a collection exists with hybrid vectors (dense cosine + sparse with IDF modifier).
   * Creates it if absent; no-ops if it already exists.
   */
  async ensureCollection(collectionName: string): Promise<void> {
    const collections = await this.client.getCollections();
    const exists = collections.collections.some(
      (c) => c.name === collectionName,
    );

    if (exists) return;

    await this.client.createCollection(collectionName, {
      vectors: {
        dense: {
          size: DENSE_DIM,
          distance: 'Cosine',
        },
      },
      sparse_vectors: {
        sparse: { modifier: 'idf' },
      },
    });

    this.logger.log(`Collection created: ${collectionName}`);
  }

  /**
   * Upsert a single point (dense vector + payload) into a collection.
   */
  async upsertPoint(
    collectionName: string,
    id: string | number,
    vector: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureCollection(collectionName);
    await this.client.upsert(collectionName, {
      points: [
        {
          id,
          vector: { dense: vector },
          payload,
        },
      ],
    });
  }

  /**
   * Upsert a single point with both dense and sparse vectors (hybrid indexing).
   */
  async upsertPointHybrid(
    collectionName: string,
    id: string | number,
    dense: number[],
    sparse: SparseVector,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureCollection(collectionName);
    await this.client.upsert(collectionName, {
      points: [
        {
          id,
          vector: {
            dense,
            sparse,
          },
          payload,
        },
      ],
    });
  }

  /**
   * Search for the nearest neighbours by dense vector similarity.
   * Returns up to `limit` scored results with their payloads.
   */
  async searchSimilar(
    collectionName: string,
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<
    Array<{
      id: string | number;
      score: number;
      payload: Record<string, unknown>;
    }>
  > {
    const results = await this.client.search(collectionName, {
      vector: { name: 'dense', vector },
      limit,
      with_payload: true,
      ...(filter ? { filter } : {}),
    });

    return results.map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload ?? {},
    }));
  }

  /**
   * Hybrid search: combines dense and sparse (RRF) for better retrieval.
   * Embeds the query text into both dense and sparse vectors and fuses results.
   */
  async searchSimilarHybrid(
    collectionName: string,
    queryText: string,
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<
    Array<{
      id: string | number;
      score: number;
      payload: Record<string, unknown>;
    }>
  > {
    const [dense, sparse] = await Promise.all([
      this.embed(queryText),
      this.embedSparse(queryText),
    ]);

    const prefetchLimit = Math.max(limit * 2, 20);
    const response = await this.client.query(collectionName, {
      prefetch: [
        {
          query: { nearest: dense },
          using: 'dense',
          limit: prefetchLimit,
          ...(filter ? { filter } : {}),
        },
        {
          query: { nearest: sparse },
          using: 'sparse',
          limit: prefetchLimit,
          ...(filter ? { filter } : {}),
        },
      ],
      query: { rrf: { k: 60 } },
      limit,
      with_payload: true,
      ...(filter ? { filter } : {}),
    });

    const points = response.points ?? [];
    return points.map((r) => ({
      id: r.id,
      score: r.score ?? 0,
      payload: r.payload ?? {},
    }));
  }
}
