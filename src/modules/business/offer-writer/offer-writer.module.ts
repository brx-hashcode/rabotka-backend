import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { LlmModule } from '../../rag/llm/llm.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import { OfferWriterController } from './offer-writer.controller';
import { OfferWriterService } from './offer-writer.service';

/** « Rédiger avec l'IA »: offers written from a few words, within the plan. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule, LlmModule, BusinessSubscriptionModule],
  controllers: [OfferWriterController],
  providers: [OfferWriterService],
})
export class OfferWriterModule {}
