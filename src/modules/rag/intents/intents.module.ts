import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../../common/services/prisma/prisma.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { JobCategoryRegistry } from './job-category.registry';

@Module({
  imports: [ConfigModule, PrismaModule, RetrievalModule],
  providers: [JobCategoryRegistry],
  exports: [JobCategoryRegistry],
})
export class IntentsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(IntentsModule.name);

  constructor(
    private readonly categories: JobCategoryRegistry,
    private readonly config: ConfigService,
  ) {}

  /**
   * Category vectors loaded (or, the very first time, built) at boot rather
   * than on the first person to name a trade.
   *
   * Behind the same switch as the embedder warm-up in RetrievalModule: both
   * need the model in memory, and a process that does not warm the model
   * should not load it here either. Never blocks the boot, never throws.
   */
  onApplicationBootstrap(): void {
    if (this.config.get<string>('VOVA_WARMUP') !== 'true') return;

    const started = Date.now();
    void this.categories
      .prebuild()
      .then(() =>
        this.logger.log(`Category vectors ready in ${Date.now() - started}ms`),
      )
      .catch((err: unknown) =>
        this.logger.error('Category vector prebuild failed', err),
      );
  }
}
