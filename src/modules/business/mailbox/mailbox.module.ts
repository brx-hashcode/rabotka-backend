import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../../auth/auth.module';
import { BusinessSubscriptionModule } from '../subscription/business-subscription.module';
import {
  MailboxCallbackController,
  MailboxController,
} from './mailbox.controller';
import { MailboxService } from './mailbox.service';
import { InboundMailController } from './inbound-mail.controller';
import { InboxService } from './inbox.service';

/**
 * Gmail and Outlook mailboxes a business picks CVs from (OAuth, read-only),
 * and the address it forwards CVs to.
 */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService, which also signs the OAuth state.
  imports: [ConfigModule, AuthModule, BusinessSubscriptionModule],
  controllers: [
    MailboxController,
    MailboxCallbackController,
    InboundMailController,
  ],
  providers: [MailboxService, InboxService],
  exports: [MailboxService, InboxService],
})
export class MailboxModule {}
