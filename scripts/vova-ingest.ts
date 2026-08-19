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
