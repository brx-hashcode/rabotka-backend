import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FlagEmbedding } from 'fastembed';
import * as path from 'node:path';
import { QdrantService } from '../../qdrant/qdrant.service';
import { HELP_DENSE_MODEL } from './help-docs.config';
import { readNumber } from '../shared/config';

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
   * The sequence length every embedding is computed at — and the single
   * cheapest win on the assistant's hot path.
   *
   * fastembed pads to `maxLength` rather than to the longest text in the batch
   * (`setPadding({ maxLength })` in its tokenizer setup). At the default of 512
   * that means a fifteen-token WhatsApp question runs a full 512-position
   * forward pass through a 24-layer, 1024-dimension model. Measured on the
   * corpus model: **1618ms at 512, 762ms at 256, 370ms at 128** — for the same
   * three questions.
   *
   * The vectors are IDENTICAL, not merely close: e5 mean-pools over the
   * attention mask, so padding contributes nothing. Cosine similarity against
   * the 512 vector is 1.000000 at every length tested, for real expanded
   * queries and for category texts alike. Nothing has to be re-ingested — the
   * corpus vectors in Qdrant were computed at 512 and still match exactly.
   *
   * 256 rather than 128 because the ceiling here is not the question, it is
   * `expandQuery`, which appends aliases: the longest realistic expansion
   * measured ~190 characters, and a category description ~180. 256 leaves
   * roughly four times that headroom, 128 only two — and the failure mode is
   * SILENT truncation, which is the kind of quiet quality loss this module has
   * been bitten by before. `guardLength` below is what makes it loud.
   *
   * Ingestion overrides this to 512: corpus chunks are `CHUNK_MAX_WORDS` (350
   * words) and genuinely need the room. It runs in its own CLI process, so the
   * two never share an embedder and the model is still loaded once.
   */
  private maxLength(): number {
    return readNumber(this.config, 'VOVA_EMBED_MAX_LENGTH', 256);
  }

  /**
   * Says so when a text is close enough to the ceiling to be at risk.
   *
   * Truncation is silent — the vector still comes back, still has 1024
   * dimensions, and is simply computed from a clipped text. There is no error
   * to catch and no symptom beyond recall quietly getting worse, which reads as
   * "the corpus just isn't very good".
   *
   * The character estimate is deliberately pessimistic (2.5 chars/token; French
   * through this tokenizer runs nearer 3), so this warns before it truncates
   * rather than after.
   */
  private guardLength(kind: 'query' | 'passage', text: string): void {
    const budget = this.maxLength() * 2.5;
    if (text.length > budget) {
      this.logger.warn(
        `vova.embed ${kind} is ${text.length} chars against a ~${Math.round(budget)} ` +
          `budget at VOVA_EMBED_MAX_LENGTH=${this.maxLength()} — it will be ` +
          `TRUNCATED and its vector will be wrong. Raise the limit or shorten ` +
          `the text: ${JSON.stringify(text.slice(0, 80))}…`,
      );
    }
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
        maxLength: this.maxLength(),
      });
      this.embedder = embedder;
      this.logger.log(
        `Help-corpus embedder ready in ${Date.now() - started}ms ` +
          `(maxLength=${this.maxLength()})`,
      );
      return embedder;
    })();
    return this.loading;
  }

  /** Document side. Applies the `passage: ` prefix e5 expects. */
  async embedPassages(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    for (const text of texts) this.guardLength('passage', text);
    const embedder = await this.ensure();
    const vectors: number[][] = [];
    for await (const batch of embedder.passageEmbed(texts)) {
      for (const vec of batch) vectors.push(Array.from(vec));
    }
    return vectors;
  }

  /** Question side. Applies the `query: ` prefix e5 expects. */
  async embedQuery(text: string): Promise<number[]> {
    this.guardLength('query', text);
    const embedder = await this.ensure();
    return Array.from(await embedder.queryEmbed(text));
  }

  /**
   * Load the model now rather than on the first person's message.
   *
   * The cold start is almost entirely this: measured 3864ms to init, against
   * ~500ms for the LangChain and LangGraph imports put together. Nothing else
   * on the path comes close, which is why warming the LLM connection — what the
   * original brief asked for — would have bought a rounding error.
   *
   * Off by default, and that is not timidity: loading at boot moves ~1GB of RSS
   * from the first message into startup, and this module already knocked the
   * app past its 150MB terminus limit once, which made /health answer 503 and
   * failed the deploy smoke test. Turn it on once the memory headroom is
   * measured on the target host.
   */
  async warmUp(): Promise<void> {
    await this.ensure();
  }

  /** Lexical leg — the same SPLADE model the matching index already loaded. */
  async sparse(text: string): Promise<{ indices: number[]; values: number[] }> {
    return this.qdrant.sparseEmbed(text);
  }
}
