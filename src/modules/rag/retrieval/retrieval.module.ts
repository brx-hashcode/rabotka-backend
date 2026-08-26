import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QdrantModule } from '../../qdrant/qdrant.module';
import { HelpEmbeddingsService } from './embeddings.service';
import { HelpDocsStore } from './help-docs.store';
import { HelpIngestService } from './ingest.service';
import { HelpRetrieveService } from './retrieve.service';

@Module({
  imports: [ConfigModule, QdrantModule],
  providers: [
    HelpEmbeddingsService,
    HelpDocsStore,
    HelpIngestService,
    HelpRetrieveService,
  ],
  exports: [
    HelpRetrieveService,
    HelpIngestService,
    HelpDocsStore,
    // Exported for the category registry, which matches job titles against
    // category descriptions with the same multilingual model. A second embedder
    // would mean a second ~1GB model in memory for identical vectors.
    HelpEmbeddingsService,
  ],
})
export class RetrievalModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetrievalModule.name);

  constructor(
    private readonly embeddings: HelpEmbeddingsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Pay the embedder's load at boot instead of on the first person's message.
   *
   * Measured, and it is the whole cold start: 3864ms to init the model against
   * ~500ms for every lazy import on the path combined. The original plan here
   * was to warm the LLM's TLS connection, which the numbers say would have been
   * a rounding error — this is the change that measurement actually justified.
   *
   * Opt-in, because it moves ~1GB of RSS into startup and this module has
   * already pushed the app past its 150MB terminus limit once, answering
   * /health with 503 and failing the deploy smoke test. Enable it once there is
   * headroom on the target host.
   *
   * Never blocks the boot: `void`-ed and caught. A warm-up that can take the
   * process down is worse than a slow first message.
   */
  onApplicationBootstrap(): void {
    if (this.config.get<string>('VOVA_WARMUP') !== 'true') return;

    const started = Date.now();
    void this.embeddings
      .warmUp()
      .then(() =>
        this.logger.log(`Vova embedder warmed in ${Date.now() - started}ms`),
      )
      .catch((err) =>
        this.logger.error(
          'Vova embedder warm-up failed — the first message will pay for it',
          err,
        ),
      );
  }
}
