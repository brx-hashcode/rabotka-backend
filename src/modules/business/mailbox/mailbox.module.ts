import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import {
  MailboxCallbackController,
  MailboxController,
} from './mailbox.controller';
import { MailboxService } from './mailbox.service';

/** Gmail and Outlook mailboxes a business picks CVs from (OAuth, read-only). */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService, which also signs the OAuth state.
  imports: [ConfigModule, AuthModule, BusinessSubscriptionModule],
  controllers: [MailboxController, MailboxCallbackController],
  providers: [MailboxService],
  exports: [MailboxService],
})
export class MailboxModule {}
