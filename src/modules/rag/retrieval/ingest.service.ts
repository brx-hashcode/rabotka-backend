import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { chunkDoc, parseDoc, type CorpusChunk } from './chunker';
import { HelpDocsStore } from './help-docs.store';

export interface IngestReport {
  articles: number;
  chunks: number;
  removed: number;
  durationMs: number;
}

/**
 * Loads `retrieval/corpus/*.md` into the help index.
 *
 * Idempotent and re-runnable: chunk ids are derived from the article and
 * section, each article is replaced wholesale, and articles deleted from the
 * directory are removed from the index. Running it twice changes nothing;
 * running it after an edit converges.
 */
@Injectable()
export class HelpIngestService {
  private readonly logger = new Logger(HelpIngestService.name);

  constructor(private readonly store: HelpDocsStore) {}

  /**
   * `__dirname` resolves under `src/` (jest, tsx) and `dist/src/` (the image)
   * alike — which only works because the corpus is a configured nest-cli asset,
   * the same arrangement the geo dataset uses.
   */
  corpusDir(): string {
    return path.join(__dirname, 'corpus');
  }

  readCorpus(): { source: string; chunks: CorpusChunk[] }[] {
    const dir = this.corpusDir();
    if (!existsSync(dir)) {
      this.logger.warn(`No corpus directory at ${dir}`);
      return [];
    }

    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((file) => {
        const raw = readFileSync(path.join(dir, file), 'utf8');
        const doc = parseDoc(raw, path.basename(file, '.md'));
        return { source: doc.source, chunks: chunkDoc(doc) };
      });
  }

  async run(): Promise<IngestReport> {
    const started = Date.now();
    await this.store.ensureCollection();

    const docs = this.readCorpus();
    let chunks = 0;

    for (const doc of docs) {
      await this.store.replaceDoc(doc.source, doc.chunks);
      chunks += doc.chunks.length;
      this.logger.log(`Indexed "${doc.source}" (${doc.chunks.length} chunks)`);
    }

    const removed = await this.store.deleteSourcesNotIn(
      docs.map((d) => d.source),
    );

    const report: IngestReport = {
      articles: docs.length,
      chunks,
      removed,
      durationMs: Date.now() - started,
    };
    this.logger.log(
      `Corpus ingested: ${report.articles} articles, ${report.chunks} chunks, ` +
        `${report.removed} stale removed, ${report.durationMs}ms`,
    );
    return report;
  }
}
