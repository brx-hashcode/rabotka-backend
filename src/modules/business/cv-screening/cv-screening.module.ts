import { AnswerFilesModule } from '../../answer-files/answer-files.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { LlmModule } from '../../rag/llm/llm.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import { MailboxModule } from '../mailbox/mailbox.module';
import { CvScreeningController } from './cv-screening.controller';
import { MailModule } from '../../mail/mail.module';
import { CvGridController } from './cv-grid.controller';
import { CvGridService } from './cv-grid.service';
import { CvRescoreService } from './cv-rescore.service';
import { CvRemovalController } from './cv-removal.controller';
import { CvRemovalService } from './cv-removal.service';
import { CvRestoreService } from './cv-restore.service';
import { CvRetentionService } from './cv-retention.service';
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
    AnswerFilesModule,
    MailModule,
  ],
  controllers: [CvScreeningController, CvRemovalController, CvGridController],
  exports: [CvScreeningService, CvGridService],
  providers: [
    CvScreeningService,
    CvGridService,
    CvRescoreService,
    CvScreeningScheduler,
    CvChatService,
    CvCompareService,
    CvRestoreService,
    CvRemovalService,
    CvRetentionService,
  ],
})
export class CvScreeningModule {}
