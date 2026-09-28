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
    const { dedupeWindowMs, ...notification } = payload;

    if (dedupeWindowMs && (await this.isDuplicate(payload, dedupeWindowMs))) {
      this.logger.debug(
        `Suppressed repeat: ${payload.event} for ${payload.entityId}`,
      );
      return;
    }

    this.logger.debug(`Broadcasting: ${payload.event} — ${payload.title}`);

    await this.notificationService.create(notification).catch((err) => {
      this.logger.error('Failed to persist notification', err);
    });

    this.gateway.server.to('admins').emit('notification', notification);
  }

  /**
   * Fails OPEN: if the lookup errors, the alert goes out. A duplicate in the
   * bell is a nuisance; a support request or a held message nobody hears
   * about is the thing these alerts exist to prevent.
   */
  private async isDuplicate(
    payload: AdminNotificationPayload,
    windowMs: number,
  ): Promise<boolean> {
    try {
      return await this.notificationService.hasRecentUnread(
        payload.event,
        payload.entityId,
        new Date(Date.now() - windowMs),
      );
    } catch (err) {
      this.logger.warn(`Dedupe lookup failed, alerting anyway: ${err}`);
      return false;
    }
  }
}
