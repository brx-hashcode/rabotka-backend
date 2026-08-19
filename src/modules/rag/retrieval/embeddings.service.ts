import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FlagEmbedding } from 'fastembed';
import * as path from 'node:path';
import { QdrantService } from '../../qdrant/qdrant.service';
import { HELP_DENSE_MODEL } from './help-docs.config';

/**
 * Embeddings for the help corpus.
 *
 * Dense is this module's own model — multilingual, 1024d — because the matching
 * index runs English-only models and the corpus is French. Sparse is borrowed
 * from `QdrantService`: it is the same SPLADE model either way, and loading a
 * second copy would double the memory for an identical result.
 *
 * **e5 requires asymmetric prefixes.** The model was trained with `query: ` on
 * questions and `passage: ` on documents, and fastembed only applies them
 * through `queryEmbed`/`passageEmbed` — plain `embed()` skips them silently.
 * Using the wrong side is not an error anyone sees; it is a quiet loss of
 * recall that looks like "the corpus just isn't very good", which is why the
 * two paths here are separate methods and never one shared helper.
 */
@Injectable()
export class HelpEmbeddingsService {
  private readonly logger = new Logger(HelpEmbeddingsService.name);
  private embedder: FlagEmbedding | undefined;
  private loading: Promise<FlagEmbedding> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly qdrant: QdrantService,
  ) {}

  private cacheDir(): string {
    return (
      this.config.get<string>('FASTEMBED_CACHE_DIR') ??
      path.join(process.cwd(), 'local_cache')
    );
  }

  /**
   * Loaded on first use, not at boot. The model is ~1GB on disk: paying for it
   * during startup would delay every other route behind a feature that may be
   * switched off, and the API's health check with it.
   */
  private async ensure(): Promise<FlagEmbedding> {
    if (this.embedder) return this.embedder;
    this.loading ??= (async () => {
      this.logger.log(
        'Loading help-corpus dense embedder (multilingual-e5-large)…',
      );
      const started = Date.now();
      const embedder = await FlagEmbedding.init({
        model: HELP_DENSE_MODEL,
        cacheDir: this.cacheDir(),
      });
      this.embedder = embedder;
      this.logger.log(
        `Help-corpus embedder ready in ${Date.now() - started}ms`,
      );
      return embedder;
    })();
    return this.loading;
  }

  /** Document side. Applies the `passage: ` prefix e5 expects. */
  async embedPassages(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const embedder = await this.ensure();
    const vectors: number[][] = [];
    for await (const batch of embedder.passageEmbed(texts)) {
      for (const vec of batch) vectors.push(Array.from(vec));
    }
    return vectors;
  }

  /** Question side. Applies the `query: ` prefix e5 expects. */
  async embedQuery(text: string): Promise<number[]> {
    const embedder = await this.ensure();
    return Array.from(await embedder.queryEmbed(text));
  }

  /** Lexical leg — the same SPLADE model the matching index already loaded. */
  async sparse(text: string): Promise<{ indices: number[]; values: number[] }> {
    return this.qdrant.sparseEmbed(text);
  }
}
