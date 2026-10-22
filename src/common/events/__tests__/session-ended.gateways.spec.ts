import { AdInboxGateway } from '../../../modules/advertisement/gateways/ad-inbox.gateway';
import { ChatGateway } from '../../../modules/chat/chat.gateway';
import { ProfileChatGateway } from '../../../modules/profile-chat/profile-chat.gateway';
import { ProfileNotificationsGateway } from '../../../modules/profile-notification/profile-notifications.gateway';
import { ClaimCommentsGateway } from '../../../modules/ws-notifications/claim-comments.gateway';
import { JobEventsGateway } from '../../../modules/ws-notifications/job-events.gateway';
import { WsNotificationsGateway } from '../../../modules/ws-notifications/ws-notifications.gateway';
import type { SessionEndedEvent } from '../session-ended.events';

/**
 * Pentest A2-F08 (#864): sockets were authorised once, at the handshake, so
 * logging out, deactivation or archiving left them subscribed.
 */
describe('session.ended — every authenticated gateway closes the room', () => {
  function withServer<T extends object>(proto: T) {
    const disconnectSockets = jest.fn();
    const inRoom = jest.fn(() => ({ disconnectSockets }));
    const gateway = Object.create(proto) as T & {
      server: unknown;
      evictEndedSession(e: SessionEndedEvent): void;
    };
    gateway.server = { in: inRoom };
    return { gateway, inRoom, disconnectSockets };
  }

  it.each([
    [
      '/admin-notifications',
      WsNotificationsGateway.prototype,
      'admin',
      'admin-u1',
    ],
    ['/chat', ChatGateway.prototype, 'admin', 'user:u1'],
    ['/job-events', JobEventsGateway.prototype, 'profile', 'profile:u1'],
    ['/messagerie', ProfileChatGateway.prototype, 'profile', 'profile:u1'],
    [
      '/notifications',
      ProfileNotificationsGateway.prototype,
      'profile',
      'profile:u1',
    ],
    ['/ad-inbox', AdInboxGateway.prototype, 'profile', 'profile:u1'],
    [
      '/claim-comments (admin)',
      ClaimCommentsGateway.prototype,
      'admin',
      'admin:u1',
    ],
    [
      '/claim-comments (profile)',
      ClaimCommentsGateway.prototype,
      'profile',
      'profile:u1',
    ],
  ] as const)('%s', (_ns, proto, kind, room) => {
    const { gateway, inRoom, disconnectSockets } = withServer(proto);

    gateway.evictEndedSession({ kind, id: 'u1' });

    expect(inRoom).toHaveBeenCalledWith(room);
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it('leaves the other kind of principal alone', () => {
    const { gateway, inRoom } = withServer(
      ProfileNotificationsGateway.prototype,
    );

    gateway.evictEndedSession({ kind: 'admin', id: 'u1' });

    expect(inRoom).not.toHaveBeenCalled();
  });
});
