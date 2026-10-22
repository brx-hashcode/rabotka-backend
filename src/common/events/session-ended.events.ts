/**
 * A principal's access just ended: logout, admin deactivation or archive,
 * profile archive.
 *
 * Sockets are authorised once, at the handshake, so ending a session left
 * every open socket of that person subscribed until it happened to drop
 * (pentest A2-F08, #864). Each gateway answers this by disconnecting the
 * principal's room; through the Redis adapter that reaches every instance.
 * A client whose token is still valid (another device) simply reconnects.
 */
export const SESSION_ENDED = 'session.ended';

export interface SessionEndedEvent {
  kind: 'profile' | 'admin';
  id: string;
}
