/**
 * Re-indexe le corpus d'aide de VoVa. Point d'entrée de PRODUCTION.
 *
 * Le `Dockerfile` désignait déjà ce fichier — « Anything that has to run in
 * production belongs in `dist` as its own entry point; see
 * dist/src/modules/rag/retrieval/ingest.cli.js » — mais personne ne l'avait
 * écrit. Résultat : le corpus voyageait bien dans l'image, et rien ne pouvait
 * le charger dans l'index. Éditer un `.md` n'avait donc aucun effet en
 * production, silencieusement.
 *
 * POURQUOI PAS `scripts/vova-ingest.ts`. Ce script vit hors de `src/` et
 * importe `../src/...` ; l'image ne contient pas `src/`, donc il échoue en
 * MODULE_NOT_FOUND quelle que soit la façon de l'invoquer. Ce fichier-ci est
 * DANS `src/`, donc il est compilé dans `dist` avec le reste et s'exécute avec
 * un simple `node`.
 *
 * POURQUOI PAS `NestFactory.createApplicationContext`. Amorcer `AppModule`
 * démarrerait le mailer, Arcjet, le provider WhatsApp et les consommateurs de
 * file, et exigerait tous les identifiants qu'ils valident — pour lire du
 * Markdown et écrire des vecteurs. Le graphe réel tient en quatre objets ;
 * `scripts/vova-context.ts` fait le même choix et l'explique en détail.
 *
 * Usage, depuis le VPS :
 *   docker compose exec api node dist/src/modules/rag/retrieval/ingest.cli.js
 *
 * Idempotent : chaque article est remplacé en bloc, les identifiants de chunk
 * dérivent de l'article et de la section, et les articles retirés du dossier
 * sont supprimés de l'index.
 */
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { QdrantService } from '../../qdrant/qdrant.service';
import { HelpEmbeddingsService } from './embeddings.service';
import { HelpDocsStore } from './help-docs.store';
import { HelpIngestService } from './ingest.service';
import { HELP_DOCS_COLLECTION } from './help-docs.config';

async function main(): Promise<void> {
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

  const store = new HelpDocsStore(
    qdrant,
    new HelpEmbeddingsService(config, qdrant),
  );
  const ingest = new HelpIngestService(store);

  try {
    const report = await ingest.run();
    const total = await store.count();

    console.log('');
    console.log(`Collection : ${HELP_DOCS_COLLECTION}`);
    console.log(`Articles   : ${report.articles}`);
    console.log(`Chunks     : ${report.chunks}`);
    console.log(`Supprimés  : ${report.removed}`);
    console.log(`Total index: ${total}`);
    console.log(`Durée      : ${report.durationMs}ms`);

    // Un corpus vide est un échec silencieux : l'assistant répondrait « je n'ai
    // pas la réponse » à tout, ce qui ressemble à un modèle prudent plutôt qu'à
    // un index qui n'a rien reçu. Mieux vaut sortir en erreur.
    if (report.articles === 0) {
      console.error(
        "\nAUCUN article ingéré. Le dossier corpus est-il présent dans l'image ?",
      );
      process.exitCode = 1;
    }
  } finally {
    redis.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
