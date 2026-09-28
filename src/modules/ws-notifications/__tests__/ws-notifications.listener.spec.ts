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

    listener = new WsNotificationsListener(gateway, {
      create: jest.fn().mockResolvedValue(undefined),
    } as any);
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

    expect((listener as any).gateway.server.to).toHaveBeenCalledWith('admins');
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

  describe('dedupeWindowMs', () => {
    let service: { create: jest.Mock; hasRecentUnread: jest.Mock };

    const held: AdminNotificationPayload = {
      event: AdminNotificationEvent.CONVERSATION_MESSAGE_HELD,
      title: 'Message retenu',
      message: 'A → B : un message a été retenu (phone)',
      entityType: 'conversation',
      entityId: 'conv-1',
      timestamp: '2026-09-28T10:00:00.000Z',
      dedupeWindowMs: 60 * 60 * 1000,
    };

    beforeEach(() => {
      emitMock = jest.fn();
      service = {
        create: jest.fn().mockResolvedValue(undefined),
        hasRecentUnread: jest.fn().mockResolvedValue(false),
      };
      listener = new WsNotificationsListener(
        {
          server: { to: jest.fn().mockReturnValue({ emit: emitMock }) },
        } as unknown as WsNotificationsGateway,
        service as any,
      );
    });

    it('stores and pushes when nothing unread matches', async () => {
      const before = Date.now();
      await listener.handleAdminNotification(held);

      const [event, entityId, since] = service.hasRecentUnread.mock.calls[0];
      expect(event).toBe(AdminNotificationEvent.CONVERSATION_MESSAGE_HELD);
      expect(entityId).toBe('conv-1');
      // The window reaches back from now, not from the payload's timestamp.
      expect((since as Date).getTime()).toBeGreaterThanOrEqual(
        before - 60 * 60 * 1000,
      );
      expect(service.create).toHaveBeenCalledTimes(1);
      expect(emitMock).toHaveBeenCalledTimes(1);
    });

    it('drops the repeat while an earlier alert is unread', async () => {
      service.hasRecentUnread.mockResolvedValue(true);

      await listener.handleAdminNotification(held);

      expect(service.create).not.toHaveBeenCalled();
      expect(emitMock).not.toHaveBeenCalled();
    });

    // The window is an implementation detail of the listener: it must not be
    // stored as a column nor shown to the admin client.
    it('strips the window from what it stores and pushes', async () => {
      await listener.handleAdminNotification(held);

      expect(service.create.mock.calls[0][0]).not.toHaveProperty(
        'dedupeWindowMs',
      );
      expect(emitMock.mock.calls[0][1]).not.toHaveProperty('dedupeWindowMs');
    });

    // A duplicate is a nuisance; a missed support request is the failure.
    it('alerts anyway when the lookup fails', async () => {
      service.hasRecentUnread.mockRejectedValue(new Error('db down'));

      await listener.handleAdminNotification(held);

      expect(emitMock).toHaveBeenCalledTimes(1);
    });

    it('never looks anything up without a window', async () => {
      const { dedupeWindowMs: _omit, ...plain } = held;

      await listener.handleAdminNotification(plain);

      expect(service.hasRecentUnread).not.toHaveBeenCalled();
      expect(emitMock).toHaveBeenCalledTimes(1);
    });
  });
});
