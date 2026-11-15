import { createHmac, timingSafeEqual } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  signJitsiJoin,
  type JitsiJoin,
} from '../../../common/services/jitsi/jitsi-token';
import { clientAppUrl } from '../../mail/audience';

/** An event room, as `newVisioRoom('RabotkaEvt')` makes them. */
const EVENT_ROOM = /^RabotkaEvt-[A-Za-z0-9]{20}$/;

/** Anyone may come in this long before, and stay this long after. */
export const EARLY_MS = 15 * 60 * 1000;
const LATE_MS = 2 * 60 * 60 * 1000;

export type EventVisioJoin = {
  title: string;
  startsAt: string;
  endsAt: string;
  displayName: string;
} & (JitsiJoin | { provider: 'waiting'; opensAt: string });

/**
 * The visio of an HR event, on our own Jitsi. Admins join from the admin; each
 * invited profile joins from a personal link (`/reunion/<room>?t=…` on the
 * client app) that only works for that room and that person, with no account.
 */
@Injectable()
export class EventVisioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** The link a profile receives: their own, for this event's room. */
  profileLink(room: string, profileId: string): string {
    const t = this.token(room, profileId);
    return `${clientAppUrl()}/reunion/${room}?t=${profileId}.${t}`;
  }

  /** An admin, from the calendar: a moderator, always. */
  async joinAsAdmin(userId: string, room: string): Promise<EventVisioJoin> {
    if (!EVENT_ROOM.test(room)) throw new NotFoundException('Visio not found.');
    const [occurrence, user] = await Promise.all([
      this.occurrenceOf(room),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { first_name: true, last_name: true, email: true },
      }),
    ]);
    if (!user) throw new ForbiddenException();
    const name = `${user.first_name} ${user.last_name}`.trim() || user.email;
    const join = await signJitsiJoin(this.config, {
      room,
      user: { id: userId, name, email: user.email, moderator: true },
      expiresAt: new Date(occurrence.end_date.getTime() + LATE_MS),
    });
    return { ...this.baseOf(occurrence, name), ...join };
  }

  /**
   * A profile, by their link. The token names the profile and is checked
   * against this room; the profile must still be on the event.
   */
  async joinAsProfile(room: string, t: string): Promise<EventVisioJoin> {
    if (!EVENT_ROOM.test(room))
      throw new NotFoundException('Visio introuvable.');
    const [profileId, sig] = String(t ?? '').split('.');
    if (!profileId || !sig || !this.matches(room, profileId, sig)) {
      throw new ForbiddenException('Lien invalide ou expiré.');
    }
    const occurrence = await this.occurrenceOf(room, profileId);
    const profile = occurrence.profiles[0];
    if (!profile) throw new ForbiddenException('Lien invalide ou expiré.');
    const name =
      `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim() ||
      'Invité';
    const base = this.baseOf(occurrence, name);
    const opensAt = occurrence.start_date.getTime() - EARLY_MS;
    if (Date.now() < opensAt) {
      return {
        ...base,
        provider: 'waiting',
        opensAt: new Date(opensAt).toISOString(),
      };
    }
    if (Date.now() > occurrence.end_date.getTime() + LATE_MS) {
      throw new ForbiddenException('Cette réunion est terminée.');
    }
    const join = await signJitsiJoin(this.config, {
      room,
      user: {
        id: `profile-${profileId}`,
        name,
        ...(profile.avatar_url ? { avatar: profile.avatar_url } : {}),
        moderator: false,
      },
      expiresAt: new Date(occurrence.end_date.getTime() + LATE_MS),
    });
    return { ...base, ...join };
  }

  // ── Inside ───────────────────────────────────────────────────────────

  private baseOf(
    o: { title: string; start_date: Date; end_date: Date },
    displayName: string,
  ) {
    return {
      title: o.title,
      startsAt: o.start_date.toISOString(),
      endsAt: o.end_date.toISOString(),
      displayName,
    };
  }

  /**
   * The occurrence a join is for: the one going on or next to come (a series
   * shares one room), else the last one. With `profileId`, only occurrences
   * that profile is invited to.
   */
  private async occurrenceOf(room: string, profileId?: string) {
    const where = {
      visio_room: room,
      ...(profileId ? { profiles: { some: { id: profileId } } } : {}),
    };
    const select = {
      id: true,
      title: true,
      start_date: true,
      end_date: true,
      profiles: profileId
        ? {
            where: { id: profileId },
            select: {
              id: true,
              first_name: true,
              last_name: true,
              avatar_url: true,
            },
          }
        : {
            take: 0,
            select: {
              id: true,
              first_name: true,
              last_name: true,
              avatar_url: true,
            },
          },
    } as const;
    const upcoming = await this.prisma.event.findFirst({
      where: { ...where, end_date: { gte: new Date(Date.now() - LATE_MS) } },
      orderBy: { start_date: 'asc' },
      select,
    });
    const occurrence =
      upcoming ??
      (await this.prisma.event.findFirst({
        where,
        orderBy: { start_date: 'desc' },
        select,
      }));
    if (!occurrence) {
      throw profileId
        ? new ForbiddenException('Lien invalide ou expiré.')
        : new NotFoundException('Visio not found.');
    }
    return occurrence;
  }

  /** HMAC of room + profile: no table, and a link can't be bent to another room or person. */
  private token(room: string, profileId: string): string {
    const secret = this.config.get<string>('JWT_SECRET') ?? '';
    return createHmac('sha256', secret)
      .update(`event-visio:${room}:${profileId}`)
      .digest('base64url')
      .slice(0, 32);
  }

  private matches(room: string, profileId: string, sig: string): boolean {
    const expected = Buffer.from(this.token(room, profileId));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
