import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { ProfileChatController } from './profile-chat.controller';
import { ProfileChatService } from './profile-chat.service';
import { ModerationService } from './moderation/moderation.service';
import { ProfileChatGateway } from './profile-chat.gateway';

/**
 * Profile-to-profile messaging before contact details are unlocked.
 *
 * Knows nothing about payment and everything about the conversation. It READS
 * the unlock state from `ContactUnlockAttempt` — to decide whether moderation
 * still applies — and never writes it. A second copy of a paid-for state is a
 * dispute waiting to be filed.
 *
 * Deliberately NOT importing the WhatsApp or payment graphs. The nudge lands in
 * its own lot and is reached through the queue, so this module's imports stay
 * at three.
 */
@Module({
  imports: [PrismaModule, AuthModule, SystemConfigModule],
  controllers: [ProfileChatController],
  providers: [ProfileChatService, ModerationService, ProfileChatGateway],
  exports: [ProfileChatService],
})
export class ProfileChatModule {}
