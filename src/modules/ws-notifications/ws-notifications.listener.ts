import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WsNotificationsGateway } from './ws-notifications.gateway';
import { AdminNotificationService } from './admin-notification.service';
import type { AdminNotificationPayload } from '../../common/events/admin-notification.events';

@Injectable()
export class WsNotificationsListener {
  private readonly logger = new Logger(WsNotificationsListener.name);

  constructor(
    private readonly gateway: WsNotificationsGateway,
    private readonly notificationService: AdminNotificationService,
  ) {}

  @OnEvent('admin.notification.**')
  async handleAdminNotification(
    payload: AdminNotificationPayload,
  ): Promise<void> {
    this.logger.debug(`Broadcasting: ${payload.event} — ${payload.title}`);

    await this.notificationService.create(payload).catch((err) => {
      this.logger.error('Failed to persist notification', err);
    });

    this.gateway.server.to('admins').emit('notification', payload);
  }
}
