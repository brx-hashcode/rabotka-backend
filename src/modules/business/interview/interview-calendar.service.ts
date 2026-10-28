import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InterviewMode,
  InterviewStatus,
  Prisma,
  type Interview,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { businessDashboardUrl } from '../../mail/audience';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import { interviewsCalendar, type CalendarEvent } from './interview-ics';

/** How far back the calendar goes: the agenda keeps recent interviews visible. */
const PAST_DAYS = 30;
/** Enough for any business; a calendar is not an archive. */
const MAX_EVENTS = 500;

const MODE: Record<InterviewMode, string> = {
  IN_PERSON: 'En personne',
  PHONE: 'Par téléphone',
  VIDEO: 'En visio',
};

const ANSWER: Record<InterviewStatus, string> = {
  PENDING: 'En attente de la réponse du candidat',
  CONFIRMED: 'Confirmé par le candidat',
  DECLINED: 'Décliné par le candidat',
  RESCHEDULE_REQUESTED: 'Le candidat demande un autre horaire',
  CANCELLED: 'Annulé',
};

/**
 * « Ajouter à mon agenda »: a private link to the business's interviews as a
 * calendar (.ics) that Google, Outlook or Apple subscribe to and read again
 * every hour.
 */
@Injectable()
export class InterviewCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  /** The link, made the first time it is asked for. */
  async link(profileId: string) {
    const businessId = await this.businessId(profileId);
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { calendar_token: true },
    });
    const token = business?.calendar_token ?? (await this.renew(businessId));
    return urls(token);
  }

  /** A new link; the old one stops working at once (a link shared too widely). */
  async reset(profileId: string) {
    return urls(await this.renew(await this.businessId(profileId)));
  }

  /** The calendar behind a link, or 404 for a link that is not (or no longer) one. */
  async feed(token: string): Promise<string> {
    const business = token
      ? await this.prisma.business.findUnique({
          where: { calendar_token: token },
          select: { id: true, name: true },
        })
      : null;
    if (!business) throw new NotFoundException('Agenda introuvable.');
    const interviews = await this.prisma.interview.findMany({
      where: {
        business_id: business.id,
        starts_at: { gte: new Date(Date.now() - PAST_DAYS * 86_400_000) },
      },
      orderBy: { starts_at: 'asc' },
      take: MAX_EVENTS,
    });
    return interviewsCalendar(
      `Entretiens — ${business.name}`,
      interviews.map(toEvent),
    );
  }

  private async renew(businessId: string): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = randomBytes(24).toString('base64url');
      try {
        await this.prisma.business.update({
          where: { id: businessId },
          data: { calendar_token: token },
        });
        return token;
      } catch (err) {
        // A collision on 192 random bits will not happen; retry all the same.
        if (
          !(err instanceof Prisma.PrismaClientKnownRequestError) ||
          err.code !== 'P2002'
        ) {
          throw err;
        }
      }
    }
    throw new Error('Could not make a calendar link');
  }

  private async businessId(profileId: string): Promise<string> {
    const id = await this.subscriptions.businessOf(profileId);
    if (!id)
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    return id;
  }
}

/** The address to paste, and the one that opens the agenda app directly. */
function urls(token: string) {
  const origin = businessDashboardUrl().replace(/\/espace$/, '');
  const url = `${origin}/api/v1/public/calendar/${token}.ics`;
  return { url, webcalUrl: url.replace(/^https?:/, 'webcal:') };
}

export function toEvent(i: Interview): CalendarEvent {
  const status: CalendarEvent['status'] =
    i.status === InterviewStatus.CONFIRMED
      ? 'CONFIRMED'
      : i.status === InterviewStatus.CANCELLED ||
          i.status === InterviewStatus.DECLINED
        ? 'CANCELLED'
        : 'TENTATIVE';
  return {
    uid: i.id,
    sequence: Math.floor(i.updated_at.getTime() / 1000),
    startsAt: i.starts_at,
    durationMinutes: i.duration_minutes,
    summary: `Entretien — ${i.candidate_name} (${i.job_title})`,
    description: [
      `${MODE[i.mode]} · ${ANSWER[i.status]}`,
      i.response_note ? `Le candidat : « ${i.response_note} »` : null,
      i.message ? `Votre message : ${i.message}` : null,
      `${businessDashboardUrl()}/entretiens`,
    ]
      .filter(Boolean)
      .join('\n'),
    location: i.location,
    status,
  };
}
