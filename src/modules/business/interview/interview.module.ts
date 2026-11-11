import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { MailModule } from '../../mail/mail.module';
import { LlmModule } from '../../rag/llm/llm.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import {
  InterviewController,
  PublicCalendarController,
  PublicInterviewController,
} from './interview.controller';
import { InterviewCalendarService } from './interview-calendar.service';
import { InterviewScheduler } from './interview.scheduler';
import { InterviewService } from './interview.service';
import { InterviewVisioService } from './interview-visio.service';
import { InterviewReportService } from './interview-report.service';

/** « Entretiens »: interviews a business proposes, and the candidate's answer. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule, MailModule, LlmModule, BusinessSubscriptionModule],
  controllers: [
    InterviewController,
    PublicInterviewController,
    PublicCalendarController,
  ],
  providers: [
    InterviewService,
    InterviewScheduler,
    InterviewCalendarService,
    InterviewVisioService,
    InterviewReportService,
  ],
})
export class InterviewModule {}
