import { WsNotificationsListener } from '../ws-notifications.listener';
import { WsNotificationsGateway } from '../ws-notifications.gateway';
import { AdminNotificationEvent } from '../../../common/events/admin-notification.events';
import type { AdminNotificationPayload } from '../../../common/events/admin-notification.events';

describe('WsNotificationsListener', () => {
  let listener: WsNotificationsListener;
  let emitMock: jest.Mock;

  beforeEach(() => {
    emitMock = jest.fn();
    const gateway = {
      server: {
        to: jest.fn().mockReturnValue({ emit: emitMock }),
      },
    } as unknown as WsNotificationsGateway;

    listener = new WsNotificationsListener(gateway, { create: jest.fn().mockResolvedValue(undefined) } as any);
  });

  it('broadcasts notification to admins room', async () => {
    const payload: AdminNotificationPayload = {
      event: AdminNotificationEvent.PROFILE_CREATED,
      title: 'Nouveau profil',
      message: 'Jean Dupont a créé un compte',
      entityType: 'profile',
      entityId: 'profile-123',
      timestamp: '2026-03-28T12:00:00.000Z',
    };

    await listener.handleAdminNotification(payload);

    expect(
      (listener as any).gateway.server.to,
    ).toHaveBeenCalledWith('admins');
    expect(emitMock).toHaveBeenCalledWith('notification', payload);
  });

  it('handles payloads with metadata', async () => {
    const payload: AdminNotificationPayload = {
      event: AdminNotificationEvent.APPLICATION_CANCELLED,
      title: 'Candidature annulée',
      message: 'Candidature #42 annulée',
      entityType: 'application',
      entityId: '42',
      metadata: { reason: 'employer', penaltyCreated: true },
      timestamp: '2026-03-28T12:00:00.000Z',
    };

    await listener.handleAdminNotification(payload);

    expect(emitMock).toHaveBeenCalledWith('notification', payload);
  });

  it('handles different event types', async () => {
    const events = [
      AdminNotificationEvent.JOB_OFFER_CREATED,
      AdminNotificationEvent.CLAIM_UPDATED,
      AdminNotificationEvent.PAYMENT_ACTIVATION,
      AdminNotificationEvent.PENALTY_SOLVED,
      AdminNotificationEvent.EVENT_CREATED,
    ];

    for (const event of events) {
      const payload: AdminNotificationPayload = {
        event,
        title: 'Test',
        message: 'Test message',
        entityType: 'profile',
        entityId: '1',
        timestamp: new Date().toISOString(),
      };

      await listener.handleAdminNotification(payload);
    }

    expect(emitMock).toHaveBeenCalledTimes(events.length);
  });
});
