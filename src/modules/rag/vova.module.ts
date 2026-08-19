import { Module } from '@nestjs/common';
import { SystemConfigModule } from '../system-config/system-config.module';
import { RecommendationEngineModule } from '../recommendation-engine/recommendation-engine.module';
import { VovaAgentModule } from './agent/agent.module';
import { VovaService } from './vova.service';
import { VovaOfferStore } from './agent/offer.store';
import { VovaAnonymousStore } from './agent/anonymous.store';

/**
 * The seam between the WhatsApp bot and the assistant.
 *
 * Deliberately thin, and deliberately separate from `VovaAgentModule`: the bot
 * needs one method and one decision (answer, or let the bot answer). Everything
 * heavier — tools, retrieval, the model chain — stays behind it.
 */
@Module({
  imports: [SystemConfigModule, RecommendationEngineModule, VovaAgentModule],
  providers: [VovaService, VovaOfferStore, VovaAnonymousStore],
  exports: [VovaService],
})
export class VovaModule {}
