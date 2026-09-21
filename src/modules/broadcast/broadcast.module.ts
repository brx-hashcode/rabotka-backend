import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { LogModule } from '../log/log.module';
import { NotificationDispatchModule } from '../notification-dispatch/notification-dispatch.module';
import { ProfileNotificationModule } from '../profile-notification/profile-notification.module';
import { SystemConfigModule } from '../system-config/system-config.module';
import { AdminBroadcastController } from './admin-broadcast.controller';
import { BroadcastService } from './broadcast.service';
import { BroadcastProcessor } from './broadcast.processor';

/**
 * Admin broadcasts: one message to a segment.
 *
 * The controller half runs in the API, the processor half in the queue worker
 * (`worker.module.ts`) — which is why the processor is a plain provider with no
 * BullMQ decorator, matching every other processor here.
 */
@Module({
  imports: [
    // For `AdminAuthGuard`, which needs JwtService — the controller is behind
    // it, and a module that uses the guard has to supply what it injects.
    AuthModule,
    PrismaModule,
    MailModule,
    LogModule,
    SystemConfigModule,
    NotificationDispatchModule,
    ProfileNotificationModule,
  ],
  controllers: [AdminBroadcastController],
  providers: [BroadcastService, BroadcastProcessor],
  exports: [BroadcastService, BroadcastProcessor],
})
export class BroadcastModule {}
