import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { HelpEmbeddingsService } from '../retrieval/embeddings.service';
import { foldText } from '../shared/text';
import { readNumber } from '../shared/config';
import { categoryEmbeddingText, cosineSimilarity } from './category-similarity';

export interface CategoryEntry {
  id: string;
  slug: string;
  name: string;
  /**
   * Searched as well as the name.
   *
   * « Agent de caisse » matches no category NAME, but « Merchandising &
   * Commerce » describes «… tenue de caisse …». Matching names alone sent that
   * employer to the catch-all domain while the right one existed.
   */
  description: string | null;
}

/**
 * Where a category vector is kept between restarts, by the hash of the text it
 * was built from. The model's name is in the key: a vector from another model
 * is not merely stale, it lives in a different space.
 */
const VECTOR_KEY_PREFIX = 'vova:catvec:multilingual-e5-large:';

/**
 * Categories embedded per call, with a yield to the event loop between calls.
 * One passage is ~1s of CPU on the VPS; a single call for all ninety-odd froze
 * the whole API for 104s on 21 Oct, deadline and cron jobs included.
 */
const EMBED_CHUNK = 2;

/** What a stored vector was built from, so an edited category is re-embedded. */
function vectorHash(entry: CategoryEntry): string {
  return createHash('sha1')
    .update(categoryEmbeddingText(entry.name, entry.description))
    .digest('hex');
}

/** A category and how close it came, for callers that want the near misses. */
export interface CategoryMatch {
  entry: CategoryEntry;
  score: number;
}

@Injectable()
export class JobCategoryRegistry {
  private readonly logger = new Logger(JobCategoryRegistry.name);
  private readonly ttlMs: number;
  private readonly minScore: number;

  private cache: CategoryEntry[] | null = null;
  private expiresAt = 0;
  private inFlight: Promise<CategoryEntry[]> | null = null;

  /**
   * Category vectors, keyed by slug and stamped with the hash of the text they
   * were built from.
   *
   * Kept in memory rather than in Qdrant: seventy-odd vectors are nothing to
   * scan, and a collection would need an ingest step plus a schema version to
   * maintain for a set that already refreshes itself here. The hash is what
   * makes the TTL affordable — a refresh that finds the same names and
   * descriptions re-embeds nothing.
   *
   * Backed by Redis (VECTOR_KEY_PREFIX) so a restart reloads them instead of
   * re-embedding: this map starts empty after every deploy, and the first
   * person to name a trade used to pay for building all of it.
   */
  private vectors = new Map<string, { hash: string; vector: number[] }>();
  private embeddingInFlight: Promise<void> | null = null;

  /**
   * Reads Prisma directly rather than through `JobCategoryService`.
   *
   * Reuse was the first instinct and it was wrong here: importing
   * `JobCategoryModule` drags `AuthModule` and `LogModule` into the assistant's
   * graph, and that closed a require cycle which left `AuthModule` undefined at
   * module-evaluation time — the app refused to boot. Three columns from one
   * table do not justify pulling half the application in behind them.
   *
   * The embedder is `@Optional()` on purpose: every literal path below works
   * without it, so a context that has not wired retrieval degrades to the
   * matching this class has always done rather than failing to construct.
   */
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    @Optional() private readonly embeddings?: HelpEmbeddingsService,
    @Optional() @Inject(REDIS_CONNECTION) private readonly redis?: Redis,
  ) {
    this.ttlMs = readNumber(config, 'VOVA_CATEGORY_TTL_MS', 300_000);
    // e5 similarities sit high even for unrelated French text — an unrelated
    // pair lands near 0.75, so a naive 0.5 would match everything. Tuned
    // against the seeded categories; raise it if the assistant starts claiming
    // confident matches for jobs Rabotka genuinely has no domain for.
    this.minScore = readNumber(config, 'VOVA_CATEGORY_MIN_SCORE', 0.82);
  }

  async all(): Promise<CategoryEntry[]> {
    if (this.cache && Date.now() < this.expiresAt) return this.cache;

    this.inFlight ??= this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async refresh(): Promise<CategoryEntry[]> {
    try {
      const rows = await this.prisma.jobCategory.findMany({
        select: { id: true, slug: true, name: true, description: true },
        orderBy: { name: 'asc' },
      });
      this.cache = rows;
      this.expiresAt = Date.now() + this.ttlMs;
      return this.cache;
    } catch (err) {
      if (this.cache) {
        this.logger.warn(
          'Category refresh failed — serving the previous list',
          err,
        );
        this.expiresAt = Date.now() + Math.min(this.ttlMs, 30_000);
        return this.cache;
      }
      this.logger.error(
        'Category refresh failed with no cache to fall back on',
        err,
      );
      return [];
    }
  }

  /**
   * Brings `vectors` up to date with the current category list.
   *
   * Only the entries whose text actually changed are embedded, so the common
   * case — a TTL refresh that returns the same rows — costs one map lookup per
   * category and no model call at all.
   */
  private async ensureVectors(entries: CategoryEntry[]): Promise<void> {
    if (!this.embeddings || entries.length === 0) return;

    const wanted = entries.map((entry) => ({ entry, hash: vectorHash(entry) }));

    const stale = wanted.filter(
      ({ entry, hash }) => this.vectors.get(entry.slug)?.hash !== hash,
    );

    // Categories deleted in the admin must stop being suggested.
    const liveSlugs = new Set(entries.map((e) => e.slug));
    for (const slug of this.vectors.keys()) {
      if (!liveSlugs.has(slug)) this.vectors.delete(slug);
    }

    if (stale.length === 0) return;

    const stored = await this.readStored(stale.map(({ hash }) => hash));
    const missing: typeof stale = [];
    stale.forEach(({ entry, hash }) => {
      const vector = stored.get(hash);
      if (vector) this.vectors.set(entry.slug, { hash, vector });
      else missing.push({ entry, hash });
    });

    // Document side: these are the passages being searched, not the question.
    for (let i = 0; i < missing.length; i += EMBED_CHUNK) {
      const chunk = missing.slice(i, i + EMBED_CHUNK);
      const vectors = await this.embeddings.embedPassages(
        chunk.map(({ entry }) =>
          categoryEmbeddingText(entry.name, entry.description),
        ),
      );
      if (vectors.length !== chunk.length) {
        throw new Error(
          `Embedder returned ${vectors.length} vectors for ${chunk.length} categories`,
        );
      }
      chunk.forEach(({ entry, hash }, j) => {
        this.vectors.set(entry.slug, { hash, vector: vectors[j] });
      });
      await this.writeStored(chunk.map(({ hash }, j) => [hash, vectors[j]]));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    this.logger.log(
      `Category vectors: ${stale.length - missing.length} from Redis, ` +
        `${missing.length} embedded`,
    );
  }

  private async readStored(hashes: string[]): Promise<Map<string, number[]>> {
    const found = new Map<string, number[]>();
    if (!this.redis || hashes.length === 0) return found;
    try {
      const raw = await this.redis.mget(
        hashes.map((h) => VECTOR_KEY_PREFIX + h),
      );
      raw.forEach((value, i) => {
        if (value) found.set(hashes[i], JSON.parse(value) as number[]);
      });
    } catch (err) {
      this.logger.warn('Could not read stored category vectors', err);
    }
    return found;
  }

  private async writeStored(pairs: [string, number[]][]): Promise<void> {
    if (!this.redis || pairs.length === 0) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const [hash, vector] of pairs) {
        pipeline.set(VECTOR_KEY_PREFIX + hash, JSON.stringify(vector));
      }
      await pipeline.exec();
    } catch (err) {
      this.logger.warn('Could not store category vectors', err);
    }
  }

  /**
   * Build (or reload) every category vector now. Called at boot, so the first
   * person to name a trade never waits on it.
   */
  async prebuild(): Promise<void> {
    if (!this.embeddings) return;
    const entries = await this.all();
    await this.buildOnce(entries);
  }

  /** Single-flight: concurrent callers share one build. */
  private buildOnce(entries: CategoryEntry[]): Promise<void> {
    this.embeddingInFlight ??= this.ensureVectors(entries).finally(() => {
      this.embeddingInFlight = null;
    });
    return this.embeddingInFlight;
  }

  private isBuilt(entries: CategoryEntry[]): boolean {
    return entries.every(
      (entry) => this.vectors.get(entry.slug)?.hash === vectorHash(entry),
    );
  }

  /**
   * The categories closest in meaning to what someone typed, best first.
   *
   * Returns an empty list rather than throwing when embeddings are unavailable:
   * every caller already has a literal answer or a catch-all to fall back on,
   * and a domain lookup must not be the thing that breaks a conversation.
   */
  async suggest(input: string, limit = 3): Promise<CategoryMatch[]> {
    const raw = input?.trim();
    if (!raw || !this.embeddings) return [];

    try {
      const entries = await this.all();
      if (entries.length === 0) return [];

      // NEVER awaited on a person's message. Building the vectors is minutes
      // of CPU when nothing is stored, and a turn waiting on it froze the API
      // (21 Oct: 104s, a 25s deadline that could not fire, every user
      // stalled). Started in the background instead; until it lands, the
      // categories it has not reached simply do not match semantically — the
      // same literal-only answer as with no embedder at all.
      if (!this.isBuilt(entries)) {
        void this.buildOnce(entries).catch((err: unknown) =>
          this.logger.warn('Category vector build failed', err),
        );
      }
      if (this.vectors.size === 0) return [];

      // Question side. e5 was trained with asymmetric prefixes and `embedQuery`
      // is what applies the `query: ` one — using the passage side here is not
      // an error anyone sees, just quietly worse recall.
      const queryVector = await this.embeddings.embedQuery(raw);

      return entries
        .map((entry) => {
          const stored = this.vectors.get(entry.slug);
          return {
            entry,
            score: stored ? cosineSimilarity(queryVector, stored.vector) : 0,
          };
        })
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (err) {
      this.logger.warn(
        `Semantic category match failed for ${JSON.stringify(raw)} — literal matching only`,
        err,
      );
      return [];
    }
  }

  /** The best semantic match, but only when it clears the confidence bar. */
  async bestMatch(input: string): Promise<CategoryMatch | null> {
    const [best] = await this.suggest(input, 1);
    return best && best.score >= this.minScore ? best : null;
  }

  async slugs(): Promise<string[]> {
    return (await this.all()).map((c) => c.slug);
  }

  async isKnown(slug: string): Promise<boolean> {
    return (await this.all()).some((c) => c.slug === slug);
  }

  async resolve(input: string): Promise<CategoryEntry | null> {
    const raw = input?.trim();
    if (!raw) return null;

    const all = await this.all();
    if (all.length === 0) return null;

    const exact = all.find((c) => c.slug === raw);
    if (exact) return exact;

    const folded = foldText(raw);
    if (!folded) return null;

    const literal =
      all.find((c) => foldText(c.slug) === folded) ??
      all.find((c) => foldText(c.name) === folded) ??
      all.find((c) => foldText(c.name).startsWith(folded)) ??
      all.find((c) => foldText(c.name).includes(folded)) ??
      // Catches how people actually name a job: the description carries the
      // tasks («… tenue de caisse …»), the name carries the sector.
      all.find(
        (c) => c.description && foldText(c.description).includes(folded),
      ) ??
      null;

    if (literal) return literal;

    // Every step above needs the words to overlap. « Agent de sécurité » shares
    // no substring with « Gardiennage & Surveillance », so the whole cascade
    // returned null and the assistant announced « Autre » for a domain that
    // exists. Meaning is the only thing left to match on.
    const semantic = await this.bestMatch(raw);
    if (semantic) {
      this.logger.debug(
        `Category "${raw}" matched "${semantic.entry.slug}" semantically (${semantic.score.toFixed(3)})`,
      );
      return semantic.entry;
    }

    return null;
  }

  invalidate(): void {
    this.cache = null;
    this.expiresAt = 0;
    // Vectors deliberately survive: they are keyed by content hash, so the next
    // refresh re-uses every one whose category is unchanged and re-embeds only
    // what an admin actually edited.
  }
}
