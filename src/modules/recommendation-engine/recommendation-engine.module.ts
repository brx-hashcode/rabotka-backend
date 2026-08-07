import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { InteractionEventService } from './interaction-event.service';
import { UserFeatureService } from './user-feature.service';
import { UserFeatureProcessor } from './user-feature.processor';
import { CandidateSourceService } from './candidate-sources';
import { RecommendationEngineService } from './recommendation-engine.service';
import { EngineRolloutService } from './engine-rollout.service';

/**
 * Behavioural signal capture, the derived per-user preference features, and the
 * unified ranker.
 *
 * Depends only on Prisma and SystemConfig: many modules need to record events,
 * and keeping this free of feature-module imports avoids the cycles that already
 * force `forwardRef` between BotModule / PaymentsModule / AuthModule.
 */
@Module({
  imports: [PrismaModule, SystemConfigModule],
  providers: [
    InteractionEventService,
    UserFeatureService,
    UserFeatureProcessor,
    CandidateSourceService,
    RecommendationEngineService,
    EngineRolloutService,
  ],
  exports: [
    InteractionEventService,
    UserFeatureService,
    RecommendationEngineService,
    EngineRolloutService,
  ],
})
export class RecommendationEngineModule {}
