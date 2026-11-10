import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { MailModule } from '../../mail/mail.module';
import { ProfileChatModule } from '../../profile-chat/profile-chat.module';
import { BusinessMessagesController } from './business-messages.controller';
import { BusinessMessagesService } from './business-messages.service';

/** « Modèles de messages » and messages to several candidates at once. */
@Module({
  // AuthModule for ProfileAuthGuard's JwtService.
  imports: [AuthModule, MailModule, ProfileChatModule],
  controllers: [BusinessMessagesController],
  providers: [BusinessMessagesService],
})
export class BusinessMessagesModule {}
