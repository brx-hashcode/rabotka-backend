import { decodeJwt, jwtVerify } from 'jose';
import { ADMIN_ROOM, newVisioRoom, signJitsiJoin } from './jitsi-token';

const config = (env: Record<string, string>) =>
  ({ get: (k: string) => env[k] }) as never;

describe('signJitsiJoin', () => {
  it('signs a token for one room, checked by our Jitsi', async () => {
    const join = await signJitsiJoin(config({ JITSI_APP_SECRET: 's3cret' }), {
      room: 'RabotkaTeam-abc',
      user: { id: 'u1', name: 'Awa', moderator: true },
      expiresAt: new Date(Date.now() + 3600_000),
    });
    if (join.provider !== 'hosted') throw new Error('expected hosted');
    expect(join.domain).toBe('visio.hashcode.digital');
    const { payload } = await jwtVerify(
      join.jwt,
      new TextEncoder().encode('s3cret'),
      { issuer: 'rabotka', audience: 'jitsi' },
    );
    expect(payload).toMatchObject({
      sub: 'visio.hashcode.digital',
      room: 'RabotkaTeam-abc',
      context: {
        user: { id: 'u1', name: 'Awa', moderator: true },
        features: { transcription: true },
      },
    });
  });

  it('gives a guest no captions switch', async () => {
    const join = await signJitsiJoin(config({ JITSI_APP_SECRET: 's' }), {
      room: 'r',
      user: { id: 'g', name: 'Guest', moderator: false },
      expiresAt: new Date(),
    });
    if (join.provider !== 'hosted') throw new Error('expected hosted');
    const claims = decodeJwt(join.jwt) as Record<string, any>;
    expect(claims.context.features).toBeUndefined();
    // At least 15 minutes, even for an expiry already past.
    expect(claims.exp! * 1000).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it('falls back to the public room without a secret', async () => {
    const join = await signJitsiJoin(config({}), {
      room: 'r1',
      user: { id: 'u', name: 'U', moderator: true },
      expiresAt: new Date(),
    });
    expect(join).toEqual({ provider: 'jitsi', url: 'https://meet.jit.si/r1' });
  });
});

describe('newVisioRoom', () => {
  it('makes unguessable admin rooms, never an interview room', () => {
    const a = newVisioRoom('RabotkaEvt');
    const b = newVisioRoom('RabotkaTeam');
    expect(a).toMatch(ADMIN_ROOM);
    expect(b).toMatch(ADMIN_ROOM);
    expect(a).not.toMatch(/^Rabotka-/);
    expect(newVisioRoom('RabotkaEvt')).not.toBe(a);
  });
});
