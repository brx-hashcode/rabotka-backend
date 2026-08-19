import { Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmBreakerService } from './breaker.service';
import { LlmModelFactory } from './model-factory.service';
import { LlmRouterService } from './router.service';
import { LlmService } from './llm.service';
import { logResolvedChains } from './models.config';

@Module({
  imports: [ConfigModule],
  providers: [LlmBreakerService, LlmModelFactory, LlmRouterService, LlmService],
  exports: [LlmService, LlmRouterService],
})
export class LlmModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(LlmModule.name);

  onApplicationBootstrap(): void {
    logResolvedChains(this.logger);
  }
}
