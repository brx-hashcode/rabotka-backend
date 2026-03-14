import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';
import { EmbeddingModel, FlagEmbedding } from 'fastembed';

export const DENSE_MODEL = EmbeddingModel.BGESmallENV15;
export const DENSE_DIM = 384;
export const SPARSE_MODEL = 'Qdrant/bm25';

@Injectable()
export class QdrantService implements OnModuleInit {
  private readonly logger = new Logger(QdrantService.name);
  private client: QdrantClient;
  private embedder: FlagEmbedding;

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
   * Ensure a collection exists with hybrid vectors (dense cosine + sparse BM25).
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
        sparse: {},
      },
    });

    this.logger.log(`Collection created: ${collectionName}`);
  }
}
