import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { WsNotificationsGateway } from './ws-notifications.gateway';
import { WsNotificationsListener } from './ws-notifications.listener';
import { AdminNotificationService } from './admin-notification.service';
import { AdminNotificationController } from './admin-notification.controller';
import { PaymentStatusGateway } from './payment-status.gateway';
import { ClaimCommentsGateway } from './claim-comments.gateway';
import { JobEventsGateway } from './job-events.gateway';
import { LogModule } from '../log/log.module';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => AuthModule),
    PrismaModule,
    LogModule,
  ],
  controllers: [AdminNotificationController],
  providers: [
    WsNotificationsGateway,
    WsNotificationsListener,
    AdminNotificationService,
    PaymentStatusGateway,
    ClaimCommentsGateway,
    JobEventsGateway,
  ],
  exports: [
    WsNotificationsGateway,
    PaymentStatusGateway,
    ClaimCommentsGateway,
    JobEventsGateway,
  ],
})
export class WsNotificationsModule {}
