import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { LlmModule } from '../../rag/llm/llm.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import { ApplicantScoreController } from './applicant-score.controller';
import { ApplicantScoreScheduler } from './applicant-score.scheduler';
import { ApplicantScoreService } from './applicant-score.service';

/** Applicants ranked by fit with the offer, like CV analysis ranks CVs. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule, LlmModule, BusinessSubscriptionModule],
  controllers: [ApplicantScoreController],
  providers: [ApplicantScoreService, ApplicantScoreScheduler],
})
export class ApplicantScoreModule {}
