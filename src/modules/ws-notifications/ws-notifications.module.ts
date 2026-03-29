import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../common/services/prisma/prisma.module';
import { WsNotificationsGateway } from './ws-notifications.gateway';
import { WsNotificationsListener } from './ws-notifications.listener';
import { AdminNotificationService } from './admin-notification.service';
import { AdminNotificationController } from './admin-notification.controller';

@Module({
  imports: [ConfigModule, AuthModule, PrismaModule],
  controllers: [AdminNotificationController],
  providers: [
    WsNotificationsGateway,
    WsNotificationsListener,
    AdminNotificationService,
  ],
  exports: [WsNotificationsGateway],
})
export class WsNotificationsModule {}
