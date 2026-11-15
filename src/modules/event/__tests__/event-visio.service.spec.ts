import { decodeJwt } from 'jose';
import { EventVisioService } from '../services/event-visio.service';
import { visioRoomFor } from '../utils/event-visio.util';

const ROOM = 'RabotkaEvt-AbCdEfGhIjKlMnOpQrSt';
const env: Record<string, string> = {
  JWT_SECRET: 'jwt-secret',
  JITSI_APP_SECRET: 'jitsi-secret',
};

function setup(occurrence: Record<string, unknown> | null) {
  const prisma = {
    event: { findFirst: jest.fn().mockResolvedValue(occurrence) },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        first_name: 'Paul',
        last_name: 'Admin',
        email: 'paul@rabotka.co',
      }),
    },
  };
  const service = new EventVisioService(
    prisma as never,
    { get: (k: string) => env[k] } as never,
  );
  return { service, prisma };
}

const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const occurrence = (startIn: number) => ({
  id: 1,
  title: 'Daily Projet Rabotka',
  start_date: soon(startIn),
  end_date: soon(startIn + 30),
  profiles: [
    { id: 'p1', first_name: 'Awa', last_name: 'Diop', avatar_url: null },
  ],
});
const tokenOf = (link: string) => new URL(link).searchParams.get('t')!;

describe('EventVisioService', () => {
  it('lets a profile in by their own link, under their name', async () => {
    const { service } = setup(occurrence(5));
    const t = tokenOf(service.profileLink(ROOM, 'p1'));
    const join = await service.joinAsProfile(ROOM, t);
    if (join.provider !== 'hosted') throw new Error('expected hosted');
    expect(join.displayName).toBe('Awa Diop');
    const claims = decodeJwt(join.jwt) as Record<string, any>;
    expect(claims.room).toBe(ROOM);
    expect(claims.context.user).toMatchObject({
      id: 'profile-p1',
      moderator: false,
    });
  });

  it('refuses a link bent to another room or another person', async () => {
    const { service } = setup(occurrence(5));
    const t = tokenOf(service.profileLink(ROOM, 'p1'));
    const other = 'RabotkaEvt-ZZZZZZZZZZZZZZZZZZZZ';
    await expect(service.joinAsProfile(other, t)).rejects.toThrow(
      'Lien invalide',
    );
    const sig = t.split('.')[1];
    await expect(service.joinAsProfile(ROOM, `p2.${sig}`)).rejects.toThrow(
      'Lien invalide',
    );
    await expect(service.joinAsProfile(ROOM, 'p1.forged')).rejects.toThrow(
      'Lien invalide',
    );
  });

  it('refuses a profile no longer on the event', async () => {
    const { service } = setup(null);
    const t = tokenOf(service.profileLink(ROOM, 'p1'));
    await expect(service.joinAsProfile(ROOM, t)).rejects.toThrow(
      'Lien invalide',
    );
  });

  it('opens 15 minutes before: earlier, the time it opens', async () => {
    const { service } = setup(occurrence(60));
    const t = tokenOf(service.profileLink(ROOM, 'p1'));
    const join = await service.joinAsProfile(ROOM, t);
    expect(join.provider).toBe('waiting');
  });

  it('lets an admin in at any time, as a moderator', async () => {
    const { service } = setup(occurrence(24 * 60));
    const join = await service.joinAsAdmin('u1', ROOM);
    if (join.provider !== 'hosted') throw new Error('expected hosted');
    const claims = decodeJwt(join.jwt) as Record<string, any>;
    expect(claims.context.user).toMatchObject({
      name: 'Paul Admin',
      moderator: true,
    });
  });

  it('knows no room that is not an event room', async () => {
    const { service } = setup(occurrence(5));
    await expect(service.joinAsAdmin('u1', 'Rabotka-abc123')).rejects.toThrow(
      'not found',
    );
  });
});

describe('visioRoomFor', () => {
  it('keeps, adds or removes the room, never replacing one', () => {
    expect(visioRoomFor(undefined, 'R')).toBe('R');
    expect(visioRoomFor(undefined, null)).toBeNull();
    expect(visioRoomFor(false, 'R')).toBeNull();
    expect(visioRoomFor(true, 'R')).toBe('R');
    expect(visioRoomFor(true, null)).toMatch(/^RabotkaEvt-/);
  });
});
