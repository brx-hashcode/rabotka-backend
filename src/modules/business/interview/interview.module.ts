import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { MailModule } from '../../mail/mail.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import {
  InterviewController,
  PublicCalendarController,
  PublicInterviewController,
} from './interview.controller';
import { InterviewCalendarService } from './interview-calendar.service';
import { InterviewScheduler } from './interview.scheduler';
import { InterviewService } from './interview.service';

/** « Entretiens »: interviews a business proposes, and the candidate's answer. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule, MailModule, BusinessSubscriptionModule],
  controllers: [
    InterviewController,
    PublicInterviewController,
    PublicCalendarController,
  ],
  providers: [InterviewService, InterviewScheduler, InterviewCalendarService],
})
export class InterviewModule {}
