import { Injectable, Logger } from '@nestjs/common';
import { QdrantService, retryTransient } from '../../qdrant/qdrant.service';
import { HelpEmbeddingsService } from './embeddings.service';
import {
  HELP_DENSE_DIM,
  HELP_DOCS_COLLECTION,
  HELP_INDEXED_KEYS,
  HELP_SCHEMA_VERSION,
  PREFETCH_LIMIT,
} from './help-docs.config';
import type { CorpusChunk } from './chunker';

export interface HelpHit {
  id: string;
  score: number;
  rank: number;
  source: string;
  title: string;
  section: string;
  text: string;
  actionId: string | null;
  needsTool: string | null;
}

/**
 * Storage for the help corpus.
 *
 * Talks to the Qdrant client directly rather than through `QdrantService`'s
 * helpers, because those hardcode the matching index's 384 dimensions and its
 * payload keys. The client, the retry behaviour and the sparse embedder are
 * still shared — only the collection's own shape is different.
 */
@Injectable()
export class HelpDocsStore {
  private readonly logger = new Logger(HelpDocsStore.name);

  constructor(
    private readonly qdrant: QdrantService,
    private readonly embeddings: HelpEmbeddingsService,
  ) {}

  private client() {
    return this.qdrant.getClient();
  }

  /**
   * Creates the collection if absent, and its payload indexes either way —
   * Qdrant does not build an index retroactively, so an existing collection
   * still needs the second half. An unindexed filter is a full scan.
   */
  async ensureCollection(): Promise<void> {
    const client = this.client();
    const existing = await retryTransient(() => client.getCollections());
    const exists = existing.collections.some(
      (c) => c.name === HELP_DOCS_COLLECTION,
    );

    if (!exists) {
      try {
        await retryTransient(() =>
          client.createCollection(HELP_DOCS_COLLECTION, {
            vectors: { dense: { size: HELP_DENSE_DIM, distance: 'Cosine' } },
            sparse_vectors: { sparse: { modifier: 'idf' } },
          }),
        );
        this.logger.log(
          `Created ${HELP_DOCS_COLLECTION} (dense ${HELP_DENSE_DIM}d + sparse)`,
        );
      } catch (err: unknown) {
        // 409 is a concurrent create, not a failure.
        if ((err as { status?: number })?.status !== 409) throw err;
      }
    }

    for (const field of HELP_INDEXED_KEYS) {
      try {
        await retryTransient(() =>
          client.createPayloadIndex(HELP_DOCS_COLLECTION, {
            field_name: field,
            field_schema: 'keyword',
          }),
        );
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status;
        if (status === 409 || status === 400) continue;
        this.logger.warn(`Payload index "${field}" failed`, err);
      }
    }
  }

  /**
   * Replaces every chunk of one article.
   *
   * Delete-by-source then upsert, rather than upsert alone: an edit that
   * removes or renames a section leaves its old chunk behind with a valid
   * vector, and it goes on being retrieved — answering from a paragraph the
   * author already deleted. Deterministic ids make the upsert idempotent; only
   * the delete makes the *article* idempotent.
   */
  async replaceDoc(source: string, chunks: CorpusChunk[]): Promise<void> {
    const client = this.client();
    await retryTransient(() =>
      client.delete(HELP_DOCS_COLLECTION, {
        filter: { must: [{ key: 'source', match: { value: source } }] },
        wait: true,
      }),
    );

    if (chunks.length === 0) return;

    const dense = await this.embeddings.embedPassages(
      chunks.map((c) => c.text),
    );
    const sparse = await Promise.all(
      chunks.map((c) => this.embeddings.sparse(c.text)),
    );

    await retryTransient(() =>
      client.upsert(HELP_DOCS_COLLECTION, {
        wait: true,
        points: chunks.map((chunk, i) => ({
          id: chunk.id,
          vector: {
            dense: dense[i],
            sparse: { indices: sparse[i].indices, values: sparse[i].values },
          },
          payload: {
            source: chunk.source,
            title: chunk.title,
            section: chunk.section,
            action_id: chunk.actionId,
            lang: chunk.lang,
            audience: chunk.audience,
            text: chunk.text,
            needs_tool: chunk.needsTool,
            schema_version: HELP_SCHEMA_VERSION,
          },
        })),
      }),
    );
  }

  /** Points whose `source` is no longer in the corpus directory. */
  async deleteSourcesNotIn(keep: string[]): Promise<number> {
    const client = this.client();
    const result = await retryTransient(() =>
      client.scroll(HELP_DOCS_COLLECTION, {
        limit: 1000,
        with_payload: ['source'],
        with_vector: false,
      }),
    );

    const stale = new Set<string>();
    for (const point of result.points) {
      const source = (point.payload as { source?: string } | null)?.source;
      if (source && !keep.includes(source)) stale.add(source);
    }
    if (stale.size === 0) return 0;

    for (const source of stale) {
      await retryTransient(() =>
        client.delete(HELP_DOCS_COLLECTION, {
          filter: { must: [{ key: 'source', match: { value: source } }] },
          wait: true,
        }),
      );
      this.logger.log(`Removed deleted article "${source}" from the index`);
    }
    return stale.size;
  }

  /**
   * Hybrid dense+sparse search, fused server-side with RRF.
   *
   * `audience` narrows to passages that apply to the caller's role. It is a
   * `must` clause, which EXCLUDES any point lacking the key — which is exactly
   * why `HELP_SCHEMA_VERSION` moved to 2 and the corpus must be re-ingested
   * after this change, rather than the filter silently returning nothing.
   */
  async search(
    query: string,
    limit: number,
    audience?: 'worker' | 'employer',
    /**
     * Drop the lexical leg.
     *
     * The sparse model is SPLADE++ **English** and the corpus is French, so on
     * an English question it matches English tokens against French text and
     * contributes noise with enough rank to win the fusion: « How can I find a
     * verified worker? » retrieved the KYC-refusal article, while the same
     * question in French retrieved exactly the right one. The dense model is
     * genuinely multilingual, so for a non-French query it is better alone.
     */
    denseOnly = false,
  ): Promise<HelpHit[]> {
    const [dense, sparse] = await Promise.all([
      this.embeddings.embedQuery(query),
      this.embeddings.sparse(query),
    ]);

    const result = await retryTransient(() =>
      this.client().query(HELP_DOCS_COLLECTION, {
        prefetch: denseOnly
          ? [{ query: dense, using: 'dense', limit: PREFETCH_LIMIT }]
          : [
              { query: dense, using: 'dense', limit: PREFETCH_LIMIT },
              {
                query: { indices: sparse.indices, values: sparse.values },
                using: 'sparse',
                limit: PREFETCH_LIMIT,
              },
            ],
        query: { fusion: 'rrf' },
        limit,
        with_payload: true,
        ...(audience
          ? {
              filter: {
                must: [{ key: 'audience', match: { any: ['all', audience] } }],
              },
            }
          : {}),
      }),
    );

    return result.points.map((point, rank) => {
      const payload = point.payload ?? {};
      return {
        id: String(point.id),
        score: point.score,
        rank,
        source: asString(payload.source),
        title: asString(payload.title),
        section: asString(payload.section),
        text: asString(payload.text),
        actionId: asOptionalString(payload.action_id),
        needsTool: asOptionalString(payload.needs_tool),
      };
    });
  }

  async count(): Promise<number> {
    const res = await retryTransient(() =>
      this.client().count(HELP_DOCS_COLLECTION, { exact: true }),
    );
    return res.count;
  }
}

/**
 * Qdrant payloads are `unknown` at the type level, and a blind `String()` over
 * one turns an unexpected object into the literal text "[object Object]" — which
 * would then be embedded in a reply to a user. Anything that is not a string is
 * treated as absent instead.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
