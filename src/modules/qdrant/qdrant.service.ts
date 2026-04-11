import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import {
  EmbeddingModel,
  FlagEmbedding,
  SparseTextEmbedding,
  SparseEmbeddingModel,
} from 'fastembed';

export const DENSE_MODEL = EmbeddingModel.BGESmallENV15;
export const DENSE_DIM = 384;
export const SPARSE_MODEL = SparseEmbeddingModel.SpladePPEnV1;
const SEARCH_LIMIT = 20;

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private client: QdrantClient;
  private embedder: FlagEmbedding;
  private sparseEmbedder: SparseTextEmbedding;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url = this.config.get<string>('QDRANT_URL');
    if (!url) {
      throw new Error('QDRANT_URL is not set');
    }
    const apiKey = this.config.get<string>('QDRANT_API_KEY');
    if (!apiKey) {
      throw new Error('QDRANT_API_KEY is not set');
    }

    this.client = new QdrantClient({ url, apiKey });

    this.logger.log('Initializing dense embedder (BGE Small EN v1.5)…');
    this.embedder = await FlagEmbedding.init({ model: DENSE_MODEL });

    this.logger.log('Initializing sparse embedder (SPLADE PP En v1)…');
    this.sparseEmbedder = await SparseTextEmbedding.init({
      model: SPARSE_MODEL,
    });

    this.logger.log(`Qdrant client initialized → ${url}`);
  }

  getClient(): QdrantClient {
    return this.client;
  }

  // ── Dense ──────────────────────────────────────────────────────────────────

  /**
   * Embed a single text string into a dense vector (384-dim).
   */
  async embed(text: string): Promise<number[]> {
    const results = this.embedder.embed([text]);
    const { value: batch, done } = await results[Symbol.asyncIterator]().next();
    if (done || !batch?.length) {
      throw new Error('Dense embedding produced no output');
    }
    return Array.from(batch[0]);
  }

  /**
   * Embed multiple texts into dense vectors.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for await (const batch of this.embedder.embed(texts)) {
      for (const vec of batch) {
        vectors.push(Array.from(vec));
      }
    }
    return vectors;
  }

  // ── Sparse ─────────────────────────────────────────────────────────────────

  /**
   * Returns sparse indices + values for a single text (SPLADE).
   */
  async sparseEmbed(
    text: string,
  ): Promise<{ indices: number[]; values: number[] }> {
    const results = this.sparseEmbedder.embed([text]);
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

  // ── Hybrid ─────────────────────────────────────────────────────────────────

  /**
   * Returns both dense and sparse vectors in one call.
   */
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

  /**
   * Upsert a single point with hybrid (dense + sparse) vectors.
   */
  async upsertHybrid(
    collectionName: string,
    id: string,
    text: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { dense, sparse } = await this.embedHybrid(text);
    await this.client.upsert(collectionName, {
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
    });
  }

  /**
   * Hybrid search using prefetch + RRF fusion.
   */
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
    const { dense, sparse } = await this.embedHybrid(text);
    const results = await this.client.query(collectionName, {
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
    });
    return results.points.map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload as Record<string, unknown> | null,
    }));
  }

  // ── Collection ─────────────────────────────────────────────────────────────

  /**
   * Ensure a hybrid collection exists (dense cosine + sparse SPLADE with IDF).
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
        sparse: {
          modifier: 'idf',
        },
      },
    });

    this.logger.log(`Collection created: ${collectionName}`);
  }
}
