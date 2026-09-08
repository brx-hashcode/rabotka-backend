import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LlmBreakerService } from './breaker.service';
import { LlmModelFactory } from './model-factory.service';
import { LlmRouterService } from './router.service';
import { LlmService } from './llm.service';
import { logResolvedChains, resolveChain } from './models.config';
import { specId, type LlmProviderSpec } from './llm.types';

@Module({
  imports: [ConfigModule],
  providers: [LlmBreakerService, LlmModelFactory, LlmRouterService, LlmService],
  exports: [LlmService, LlmRouterService],
})
export class LlmModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(LlmModule.name);

  constructor(
    private readonly factory: LlmModelFactory,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    logResolvedChains(this.logger);
    void this.warm();
  }

  /**
   * Build the chat models at boot so no user's turn pays an SDK cold start.
   *
   * `LlmModelFactory.construct` imports each vendor's SDK dynamically, so the
   * FIRST use of a provider costs module resolution plus client construction —
   * inside the request, and specifically at the moment things are already going
   * badly, because a cold provider is one being fallen over to. Production,
   * 2026-09-01, four seconds after the user had already been answered:
   *
   *   Built chat model anthropic:claude-haiku-4-5
   *
   * A COMMA LIST rather than the `VOVA_WARMUP=true` boolean the retrieval
   * module uses, and the difference is the point: those dynamic imports exist
   * because loading every SDK costs ~83MB and pushed the app past its 150MB
   * terminus limit, answering /health with 503 and failing the deploy smoke
   * test. Warming all six would recreate that regression at boot — where it
   * fails the whole deploy rather than one message. Name the two the race
   * actually uses (`google,openai`, ~20MB) and leave Mistral, which is 67MB on
   * its own, to stay lazy.
   *
   * Never blocks the boot: `void`-ed, `allSettled`, and a failure only means
   * the model is absent from the cache and the next request rebuilds it —
   * exactly today's behaviour. A warm-up that can take the process down is
   * worse than a slow first message.
   */
  private async warm(): Promise<void> {
    const raw = this.config.get<string>('VOVA_WARMUP_PROVIDERS');
    if (!raw?.trim()) return;

    const wanted = new Set(
      raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );

    const seen = new Set<string>();
    const specs = [
      ...resolveChain('cheap'),
      ...resolveChain('standard'),
    ].filter((spec: LlmProviderSpec) => {
      if (!wanted.has(spec.provider)) return false;
      // The chain can name one provider twice (two Google models), and each
      // is a separate client worth building — but only once.
      if (seen.has(specId(spec))) return false;
      seen.add(specId(spec));
      return true;
    });

    const unknown = [...wanted].filter(
      (p) => !specs.some((s) => s.provider === p),
    );
    if (unknown.length) {
      this.logger.warn(
        `VOVA_WARMUP_PROVIDERS names ${unknown.join(', ')}, which ` +
          `${unknown.length === 1 ? 'is' : 'are'} not in any tier chain with a ` +
          `credential — nothing to warm for ${unknown.length === 1 ? 'it' : 'them'}.`,
      );
    }

    if (specs.length === 0) return;

    const started = Date.now();
    const results = await Promise.allSettled(
      specs.map((spec) => this.factory.build(spec)),
    );

    const ok = specs.filter((_, i) => results[i].status === 'fulfilled');

    this.logger.log(
      `Vova warmed ${ok.length}/${specs.length} chat models in ` +
        `${Date.now() - started}ms: ${ok.map(specId).join(', ') || '—'}`,
    );

    for (const [i, spec] of specs.entries()) {
      const result = results[i];
      if (result.status === 'rejected') {
        this.logger.error(
          `Vova warm-up failed for ${specId(spec)} — the first message that ` +
            `reaches it will pay the cold start`,
          result.reason,
        );
      }
    }
  }
}
