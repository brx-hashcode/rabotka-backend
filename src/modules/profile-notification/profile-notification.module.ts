import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { ProfileNotificationService } from './profile-notification.service';
import { ProfileNotificationsGateway } from './profile-notifications.gateway';
import { ProfileNotificationController } from './profile-notification.controller';
import { AdminProfileNotificationController } from './admin-profile-notification.controller';
import { ProfileNotificationListener } from './profile-notification.listener';
import { SimilarHireNudgeService } from './similar-hire-nudge.service';
import { ProfileWebPushService } from './profile-web-push.service';
import { WebPushModule } from '../../common/services/web-push/web-push.module';

/**
 * The per-profile in-app feed. Deliberately free of WhatsApp — the reminder
 * lives in `ProfileViewsReminderModule` and is reached by event, so the feed
 * modules that import this one do not inherit WhatsApp's import graph.
 */
@Module({
  imports: [
    ConfigModule,
    AuthModule,
    PrismaModule,
    SystemConfigModule,
    WebPushModule,
  ],
  controllers: [
    ProfileNotificationController,
    AdminProfileNotificationController,
  ],
  providers: [
    ProfileNotificationService,
    ProfileNotificationsGateway,
    ProfileNotificationListener,
    SimilarHireNudgeService,
    ProfileWebPushService,
  ],
  exports: [ProfileNotificationService],
})
export class ProfileNotificationModule {}
