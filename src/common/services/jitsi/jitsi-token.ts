import { randomBytes } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';

/**
 * Our own Jitsi (visio.hashcode.digital; https://localhost:8443 locally).
 * Every room needs a token: HS256 with JITSI_APP_SECRET, which must equal the
 * server's JWT_APP_SECRET. Shared by the interviews (Rabotka Business), the
 * admin's HR events and its team-chat calls.
 */
export type JitsiJoin =
  | { provider: 'hosted'; domain: string; roomName: string; jwt: string }
  /** No secret (before it is set): the public Jitsi room. */
  | { provider: 'jitsi'; url: string };

export type JitsiUser = {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  /** Mutes others, ends the call, and starts the captions. */
  moderator: boolean;
};

export async function signJitsiJoin(
  config: ConfigService,
  input: { room: string; user: JitsiUser; expiresAt: Date },
): Promise<JitsiJoin> {
  const { room, user } = input;
  const secret = config.get<string>('JITSI_APP_SECRET')?.trim();
  if (!secret) return { provider: 'jitsi', url: `https://meet.jit.si/${room}` };
  const domain =
    config.get<string>('JITSI_DOMAIN')?.trim() || 'visio.hashcode.digital';
  const appId = config.get<string>('JITSI_APP_ID')?.trim() || 'rabotka';
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.floor(input.expiresAt.getTime() / 1000);
  // The server checks iss (its JWT_APP_ID), aud and sub; `room` keeps the
  // token to that one room.
  const jwt = await new SignJWT({
    aud: 'jitsi',
    iss: appId,
    sub: domain,
    room,
    context: {
      user: {
        id: user.id,
        name: user.name,
        ...(user.email ? { email: user.email } : {}),
        ...(user.avatar ? { avatar: user.avatar } : {}),
        moderator: user.moderator,
      },
      // Only a moderator starts the captions (the server's transcriber);
      // everyone in the call sees them once they're on.
      ...(user.moderator ? { features: { transcription: true } } : {}),
    },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setNotBefore(now - 60)
    .setExpirationTime(Math.max(exp, now + 15 * 60))
    .sign(new TextEncoder().encode(secret));
  return { provider: 'hosted', domain, roomName: room, jwt };
}

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A room nobody can guess: `<prefix>-` and 20 random letters or digits. The
 * admin's prefixes (RabotkaEvt, RabotkaTeam) never match an interview room
 * (`Rabotka-…`), so each kind of room is only ever joined its own way.
 */
export function newVisioRoom(prefix: 'RabotkaEvt' | 'RabotkaTeam'): string {
  const bytes = randomBytes(20);
  let id = '';
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return `${prefix}-${id}`;
}

export const ADMIN_ROOM = /^Rabotka(Evt|Team)-[A-Za-z0-9]{20}$/;
