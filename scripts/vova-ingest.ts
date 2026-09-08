/**
 * Builds (or rebuilds) the Vova help corpus index.
 *
 * Idempotent and safe to re-run: each article is replaced wholesale, chunk ids
 * are derived from the article and section, and articles deleted from
 * `src/modules/rag/retrieval/corpus/` are removed from the index.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/vova-ingest.ts
 *
 * First run downloads the multilingual embedding model (~1 GB) into
 * `local_cache/`, so expect it to take a while and to need disk. Later runs
 * reuse the cache.
 */
import { config } from 'dotenv';
import { createVovaContext } from './vova-context';
import { HELP_DOCS_COLLECTION } from '../src/modules/rag/retrieval/help-docs.config';

config({ path: '.env.local' });
config({ path: '.env' });

/**
 * Ingestion embeds at the model's full sequence length; the API does not.
 *
 * The serving side runs a much shorter `VOVA_EMBED_MAX_LENGTH` because a
 * WhatsApp question is a few dozen tokens and fastembed pads to the limit
 * rather than to the text — that is worth ~1.2s per message. Corpus chunks are
 * `CHUNK_MAX_WORDS` (350 words) and would be silently TRUNCATED at that
 * setting, which is a quality loss nothing would report: the vectors still come
 * back, just computed from clipped text.
 *
 * Set before `createVovaContext()` because the value is read when the embedder
 * is built. `??=` so an explicit override on the command line still wins.
 *
 * Safe to differ from the serving value: padding contributes nothing through
 * e5's masked mean-pooling, so a query embedded at 256 and a passage embedded
 * at 512 land in the same space — measured at cosine 1.000000 against the
 * same text embedded at both lengths.
 */
process.env.VOVA_EMBED_MAX_LENGTH ??= '512';

async function main() {
  const ctx = createVovaContext();

  try {
    const report = await ctx.ingest.run();
    const total = await ctx.store.count();

    console.log('');
    console.log(`Collection : ${HELP_DOCS_COLLECTION}`);
    console.log(`Articles   : ${report.articles}`);
    console.log(`Chunks     : ${report.chunks}`);
    console.log(`Removed    : ${report.removed}`);
    console.log(`In index   : ${total}`);
    console.log(`Duration   : ${report.durationMs}ms`);
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
