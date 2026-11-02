import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { ProfileChatController } from './profile-chat.controller';
import { ProfileChatService } from './profile-chat.service';
import { ModerationService } from './moderation/moderation.service';
import { ProfileChatGateway } from './profile-chat.gateway';
import { PresenceService } from './presence.service';
import { AdminConversationController } from './admin-profile-chat.controller';
import { AdminConversationThreadController } from './admin-profile-chat-thread.controller';
import { AdminProfileChatService } from './admin-profile-chat.service';
import { LogModule } from '../log/log.module';
import { BusinessSubscriptionModule } from '../business/subscription/business-subscription.module';

/**
 * Profile-to-profile messaging before contact details are unlocked.
 *
 * Knows nothing about payment and everything about the conversation. It READS
 * the unlock state from `ContactUnlockAttempt` — to decide whether moderation
 * still applies — and never writes it. A second copy of a paid-for state is a
 * dispute waiting to be filed.
 *
 * Deliberately NOT importing the WhatsApp or payment graphs. The nudge lands in
 * its own lot and is reached through the queue. The one business import is
 * the subscription core, which imports none of the flows: a business without a
 * plan reads its conversations and writes in none.
 */
@Module({
  // LogModule is here for the thread controller alone: reading two people's
  // messages writes an audit row, and that row is the permission model rather
  // than telemetry.
  imports: [
    PrismaModule,
    AuthModule,
    SystemConfigModule,
    LogModule,
    BusinessSubscriptionModule,
  ],
  controllers: [
    ProfileChatController,
    AdminConversationController,
    AdminConversationThreadController,
  ],
  providers: [
    ProfileChatService,
    ModerationService,
    ProfileChatGateway,
    PresenceService,
    AdminProfileChatService,
  ],
  exports: [ProfileChatService],
})
export class ProfileChatModule {}
