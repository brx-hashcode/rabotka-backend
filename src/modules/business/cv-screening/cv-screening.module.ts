import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { LlmModule } from '../../rag/llm/llm.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import { MailboxModule } from '../mailbox/mailbox.module';
import { CvScreeningController } from './cv-screening.controller';
import { CvScreeningScheduler } from './cv-screening.scheduler';
import { CvScreeningService } from './cv-screening.service';
import { CvChatService } from './cv-chat.service';
import { CvCompareService } from './cv-compare.service';

/** « Analyse de CV »: AI screening of CVs a business uploads, within its plan. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [
    ConfigModule,
    AuthModule,
    LlmModule,
    BusinessSubscriptionModule,
    MailboxModule,
  ],
  controllers: [CvScreeningController],
  exports: [CvScreeningService],
  providers: [
    CvScreeningService,
    CvScreeningScheduler,
    CvChatService,
    CvCompareService,
  ],
})
export class CvScreeningModule {}
