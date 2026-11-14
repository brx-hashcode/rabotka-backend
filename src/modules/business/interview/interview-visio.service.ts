import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InterviewMode, InterviewStatus } from '@prisma/client';
import { SignJWT } from 'jose';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { businessDashboardUrl } from '../../mail/audience';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import { hashToken } from './interview.service';
import { businessPersonName } from './interview-people';
import { assertVideoPlan, VIDEO_GUEST_REFUSAL } from './interview-plan';

/** « Créer un lien de visio » makes these: the room is the random part. */
const ROOM = /^Rabotka-[A-Za-z0-9]{6,32}$/;

/** Guests may come in this long before, and anyone stay this long after. */
const EARLY_MS = 24 * 60 * 60 * 1000;
const LATE_MS = 2 * 60 * 60 * 1000;

/** The room's own link, as kept in `Interview.location`. */
export function visioUrl(room: string): string {
  return `${businessDashboardUrl().replace(/\/espace$/, '')}/visio/${room}`;
}

/** The interview as the visio pages read it. */
type VisioInterview = {
  id: string;
  job_title: string;
  candidate_name: string;
  starts_at: Date;
  duration_minutes: number;
  ended_at?: Date | null;
  business: { name: string; profile?: { avatar_url: string | null } | null };
};

export type VisioJoin = {
  jobTitle: string;
  businessName: string;
  candidateName: string;
  startsAt: string;
  durationMinutes: number;
  /** Shown in the call; the visitor may change it before joining. */
  displayName: string;
  host: boolean;
  businessLogoUrl: string | null;
  endedAt: string | null;
  /** The host only: for the « Compte rendu » beside the call. */
  interviewId?: string;
} &
  /** Our own Jitsi (visio.hashcode.digital; localhost:8000 in development). */
  (
    | { provider: 'hosted'; domain: string; roomName: string; jwt: string }
    /** Too early (a guest, before the day before): when it opens, no token yet. */
    | { provider: 'waiting'; opensAt: string }
    /** No Jitsi secret (before it is set): the public Jitsi room. */
    | { provider: 'jitsi'; url: string }
  );

/**
 * The video call of an interview, inside the app, on our own Jitsi server.
 * Its rooms need a token we sign (JWT, HS256): the business joins as host,
 * whoever holds the room's link as a guest, and only around the interview's
 * time, each token for its own room.
 */
@Injectable()
export class InterviewVisioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  /** The business's side: a host of the call. */
  async asHost(
    profileId: string,
    memberId: string | undefined,
    room: string,
  ): Promise<VisioJoin> {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId)
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    // A room already booked closes too when the plan lacks the visio.
    await assertVideoPlan(this.subscriptions, businessId);
    const interview = await this.find(room, businessId);
    // The person, by name (the holder's own row too), prefilled in the call.
    const who = await businessPersonName(
      this.prisma,
      businessId,
      memberId,
      interview.business.name,
    );
    return this.join(interview, room, {
      id: memberId ?? profileId,
      name: who.name,
      email: who.email ?? interview.business.profile.email ?? undefined,
      avatar: memberId
        ? undefined
        : (interview.business.profile.avatar_url ?? undefined),
      host: true,
    });
  }

  /**
   * Whoever holds the link, as a guest: the candidate by the room's link,
   * someone the business invited by their personal one (`guestToken`).
   */
  async asGuest(room: string, guestToken?: string): Promise<VisioJoin> {
    const interview = await this.find(room);
    // The business's plan lacks the visio: no one joins, without the plan's words.
    const plan = await this.subscriptions.entitlements(interview.business_id);
    if (!plan.videoInterviews)
      throw new ForbiddenException(VIDEO_GUEST_REFUSAL);
    const user = await this.guestOf(interview, guestToken);
    // Too early: what the page needs to say when, and to get ready; no token yet.
    const opensAt = interview.starts_at.getTime() - EARLY_MS;
    if (opensAt > Date.now()) {
      return {
        ...this.baseOf(interview, user),
        provider: 'waiting',
        opensAt: new Date(opensAt).toISOString(),
      };
    }
    return this.join(interview, room, user);
  }

  /** The candidate by the room's link, or an invited person by their own. */
  private async guestOf(
    interview: { id: string; candidate_name: string },
    guestToken?: string,
  ) {
    if (guestToken) {
      const guest = await this.prisma.interviewGuest.findFirst({
        where: {
          token_hash: hashToken(guestToken),
          interview_id: interview.id,
        },
        select: { id: true, name: true, email: true },
      });
      if (!guest) {
        throw new NotFoundException(
          'Cette invitation n’est plus valable : demandez un nouveau lien à l’entreprise.',
        );
      }
      return {
        id: `invite-${guest.id}`,
        name: guest.name,
        email: guest.email,
        host: false,
      };
    }
    return {
      id: `guest-${interview.id}`,
      name: interview.candidate_name,
      host: false,
    };
  }

  private async find(room: string, businessId?: string) {
    if (!ROOM.test(room)) throw new NotFoundException('Visio introuvable.');
    const interview = await this.prisma.interview.findFirst({
      where: {
        location: visioUrl(room),
        mode: InterviewMode.VIDEO,
        ...(businessId ? { business_id: businessId } : {}),
      },
      orderBy: { starts_at: 'desc' },
      include: {
        business: {
          select: {
            name: true,
            profile: { select: { email: true, avatar_url: true } },
          },
        },
      },
    });
    if (!interview) throw new NotFoundException('Visio introuvable.');
    if (interview.status === InterviewStatus.CANCELLED) {
      throw new BadRequestException('Cet entretien a été annulé.');
    }
    if (interview.status === InterviewStatus.DECLINED) {
      throw new BadRequestException('Cet entretien a été décliné.');
    }
    if (this.endOf(interview) + LATE_MS < Date.now()) {
      throw new BadRequestException('Cet entretien est terminé.');
    }
    // Ended by the business: the guests' link closes; the host still sees the page.
    if (interview.ended_at && !businessId) {
      throw new BadRequestException('Cet entretien est terminé.');
    }
    return interview;
  }

  private endOf(i: { starts_at: Date; duration_minutes: number }): number {
    return i.starts_at.getTime() + i.duration_minutes * 60_000;
  }

  /** What every visio page shows: who invites, for what, when. */
  private baseOf(
    interview: VisioInterview,
    user: { name: string; host: boolean },
  ) {
    return {
      jobTitle: interview.job_title,
      businessName: interview.business.name,
      businessLogoUrl: interview.business.profile?.avatar_url ?? null,
      candidateName: interview.candidate_name,
      startsAt: interview.starts_at.toISOString(),
      durationMinutes: interview.duration_minutes,
      displayName: user.name,
      host: user.host,
      /** Ended by the business: the page shows it over, not the call. */
      endedAt: interview.ended_at?.toISOString() ?? null,
      // The host's page keeps the « Compte rendu » notes beside the call.
      ...(user.host ? { interviewId: interview.id } : {}),
    };
  }

  private async join(
    interview: VisioInterview,
    room: string,
    user: {
      id: string;
      name: string;
      email?: string;
      avatar?: string;
      host: boolean;
    },
  ): Promise<VisioJoin> {
    const base = this.baseOf(interview, user);
    const secret = this.config.get<string>('JITSI_APP_SECRET')?.trim();
    if (!secret) {
      return { ...base, provider: 'jitsi', url: `https://meet.jit.si/${room}` };
    }
    const domain =
      this.config.get<string>('JITSI_DOMAIN')?.trim() ||
      'visio.hashcode.digital';
    const appId = this.config.get<string>('JITSI_APP_ID')?.trim() || 'rabotka';
    const now = Math.floor(Date.now() / 1000);
    const exp = Math.floor((this.endOf(interview) + LATE_MS) / 1000);
    // The server checks iss (its JWT_APP_ID), aud and sub; `room` keeps the
    // token to this interview's room only.
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
          moderator: user.host,
        },
      },
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setNotBefore(now - 60)
      .setExpirationTime(Math.max(exp, now + 15 * 60))
      .sign(new TextEncoder().encode(secret));
    return { ...base, provider: 'hosted', domain, roomName: room, jwt };
  }
}
