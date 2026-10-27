import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { LlmModule } from '../../rag/llm/llm.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import { CvScreeningController } from './cv-screening.controller';
import { CvScreeningScheduler } from './cv-screening.scheduler';
import { CvScreeningService } from './cv-screening.service';

/** « Analyse de CV »: AI screening of CVs a business uploads, within its plan. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [ConfigModule, AuthModule, LlmModule, BusinessSubscriptionModule],
  controllers: [CvScreeningController],
  providers: [CvScreeningService, CvScreeningScheduler],
})
export class CvScreeningModule {}
