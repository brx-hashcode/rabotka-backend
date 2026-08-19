import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { foldText } from '../shared/text';
import { readNumber } from '../shared/config';

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

@Injectable()
export class JobCategoryRegistry {
  private readonly logger = new Logger(JobCategoryRegistry.name);
  private readonly ttlMs: number;

  private cache: CategoryEntry[] | null = null;
  private expiresAt = 0;
  private inFlight: Promise<CategoryEntry[]> | null = null;

  /**
   * Reads Prisma directly rather than through `JobCategoryService`.
   *
   * Reuse was the first instinct and it was wrong here: importing
   * `JobCategoryModule` drags `AuthModule` and `LogModule` into the assistant's
   * graph, and that closed a require cycle which left `AuthModule` undefined at
   * module-evaluation time — the app refused to boot. Three columns from one
   * table do not justify pulling half the application in behind them.
   */
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.ttlMs = readNumber(config, 'VOVA_CATEGORY_TTL_MS', 300_000);
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

    return (
      all.find((c) => foldText(c.slug) === folded) ??
      all.find((c) => foldText(c.name) === folded) ??
      all.find((c) => foldText(c.name).startsWith(folded)) ??
      all.find((c) => foldText(c.name).includes(folded)) ??
      // Last resort, and the one that catches how people actually name a job:
      // the description carries the tasks («… tenue de caisse …»), the name
      // carries the sector.
      all.find(
        (c) => c.description && foldText(c.description).includes(folded),
      ) ??
      null
    );
  }

  invalidate(): void {
    this.cache = null;
    this.expiresAt = 0;
  }
}
