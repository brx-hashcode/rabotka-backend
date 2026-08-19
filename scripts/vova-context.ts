/**
 * Minimal object graph for the Vova CLIs.
 *
 * Deliberately hand-wired instead of `NestFactory.createApplicationContext`,
 * for two reasons:
 *
 * 1. **`tsx` cannot boot Nest DI.** It transpiles with esbuild, which does not
 *    emit `design:paramtypes`, so every constructor injection resolves to
 *    `undefined`. Services that merely *store* their dependencies appear to
 *    work and fail later at first use; the failure is silent until it isn't.
 *    (`ts-node` does emit the metadata, but chokes on this repo's `.js`
 *    import specifiers, which only Jest's `moduleNameMapper` rewrites.)
 * 2. Booting `AppModule` for a corpus tool would start the mailer, Arcjet, the
 *    WhatsApp provider and the queue consumers, and demand every credential
 *    they validate — to read some Markdown and write vectors.
 *
 * Four objects is the whole dependency graph of the retrieval stack. Writing
 * them out is cheaper than either workaround, and it makes what the CLI
 * actually touches obvious.
 */
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { QdrantService } from '../src/modules/qdrant/qdrant.service';
import { HelpEmbeddingsService } from '../src/modules/rag/retrieval/embeddings.service';
import { HelpDocsStore } from '../src/modules/rag/retrieval/help-docs.store';
import { HelpIngestService } from '../src/modules/rag/retrieval/ingest.service';
import { HelpRetrieveService } from '../src/modules/rag/retrieval/retrieve.service';

export interface VovaContext {
  store: HelpDocsStore;
  ingest: HelpIngestService;
  retrieve: HelpRetrieveService;
  close: () => Promise<void>;
}

export function createVovaContext(): VovaContext {
  const config = new ConfigService();

  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    ...(process.env.REDIS_PASSWORD
      ? { password: process.env.REDIS_PASSWORD }
      : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  const qdrant = new QdrantService(config, redis);
  qdrant.onModuleInit();

  const embeddings = new HelpEmbeddingsService(config, qdrant);
  const store = new HelpDocsStore(qdrant, embeddings);

  return {
    store,
    ingest: new HelpIngestService(store),
    retrieve: new HelpRetrieveService(store, config),
    close: async () => {
      redis.disconnect();
      await Promise.resolve();
    },
  };
}
