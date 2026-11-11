import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { businessEmailRecipientsOfProfile } from '../team/business-recipients';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes } from 'node:crypto';
import {
  ApplicationStatus,
  CvScreeningResumeStatus,
  ExternalApplicationStatus,
  InterviewMode,
  InterviewStatus,
  type Interview,
} from '@prisma/client';
import { isTerminalJobOfferStatus } from '../../job-offer/utils/job-offer-status.util';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { LayoutService } from '../../mail/layout.service';
import { businessDashboardUrl } from '../../mail/audience';
import { notifyProfile } from '../../profile-notification/profile-notification.events';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import {
  frWhen,
  interviewAnsweredEmail,
  interviewCancelledEmail,
  interviewChosenEmail,
  interviewInviteEmail,
  interviewReminderEmail,
  type InterviewMail,
} from './interview-emails';
import { interviewIcs } from './interview-ics';

export const INTERVIEW_DURATIONS = [15, 30, 45, 60, 90, 120];
/** An interview is proposed at least this far ahead. */
const MIN_LEAD_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type InterviewInput = {
  cvResumeId?: string;
  applicationId?: string;
  externalApplicationId?: string;
  /** One time; or `options`, 2 or 3 times the candidate chooses from. */
  startsAt?: string;
  options?: string[];
  durationMinutes: number;
  mode: InterviewMode;
  location?: string | null;
  message?: string | null;
  /** For an analysed CV: where to send it, when the CV has none or a wrong one. */
  candidateEmail?: string | null;
};

export type InterviewAnswer = 'CONFIRMED' | 'DECLINED' | 'RESCHEDULE_REQUESTED';

type Loaded = Interview & {
  /** Loaded with LOAD; absent on a row read without it. */
  slots?: { id: string; starts_at: Date }[];
  business: {
    name: string;
    profile_id: string;
    profile: { avatar_url: string | null; email: string | null };
  };
  application: {
    worker: { id: string; email: string | null };
  } | null;
};

const LOAD = {
  business: {
    select: {
      name: true,
      profile_id: true,
      profile: { select: { avatar_url: true, email: true } },
    },
  },
  application: { select: { worker: { select: { id: true, email: true } } } },
  slots: {
    select: { id: true, starts_at: true },
    orderBy: { starts_at: 'asc' as const },
  },
} as const;

/** Times a business may offer for one interview. */
export const MAX_INTERVIEW_OPTIONS = 3;

/**
 * Interviews a business proposes to a candidate: one whose CV it analysed or
 * one who applied to its offer. The candidate is invited by e-mail (with the
 * calendar file and a private link to answer), an applicant also in-app; the
 * business sees the answer live and both get a reminder the day before.
 */
@Injectable()
export class InterviewService {
  private readonly logger = new Logger(InterviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly events: EventEmitter2,
  ) {}

  // ── The business ─────────────────────────────────────────────────────

  async create(profileId: string, input: InterviewInput) {
    const businessId = await this.businessOf(profileId);
    const sources = [
      input.cvResumeId,
      input.applicationId,
      input.externalApplicationId,
    ].filter(Boolean);
    if (sources.length !== 1) {
      throw new BadRequestException(
        'Choisissez le candidat : un CV analysé ou une candidature.',
      );
    }
    const slot = this.slot(input);
    const externalId = input.externalApplicationId ?? null;
    // A CV analysed for a Rabotka applicant is their application: invited as
    // one (profile e-mail, in-app notice), never through the CV's masked
    // contacts, and closed with it if they are turned down.
    const applicationId =
      input.applicationId ??
      (input.cvResumeId
        ? await this.applicationOfResume(businessId, input.cvResumeId)
        : null);
    const who = applicationId
      ? await this.fromApplication(profileId, applicationId)
      : externalId
        ? await this.fromExternal(profileId, externalId)
        : await this.fromCv(
            businessId,
            input.cvResumeId!,
            input.candidateEmail,
          );

    const token = randomBytes(24).toString('base64url');
    const created = await this.prisma.interview.create({
      data: {
        business_id: businessId,
        cv_resume_id: applicationId ? null : (input.cvResumeId ?? null),
        application_id: applicationId ?? null,
        external_application_id: externalId,
        offer_id: who.offerId,
        job_title: who.jobTitle,
        candidate_name: who.name,
        candidate_email: who.email,
        ...slot.fields,
        token_hash: hashToken(token),
        // Within a day the invitation itself is the reminder: « demain »
        // would be wrong, and it came a few minutes after it.
        reminded_at: soon(slot.fields.starts_at) ? new Date() : null,
        ...(slot.options.length > 1
          ? { slots: { create: slot.options.map((d) => ({ starts_at: d })) } }
          : {}),
      },
      include: LOAD,
    });
    await this.invite(created, token, false);
    return view(created);
  }

  async list(
    profileId: string,
    filter: {
      scope?: 'upcoming' | 'past';
      cvResumeId?: string;
      applicationId?: string;
      externalApplicationId?: string;
    },
  ) {
    const businessId = await this.businessOf(profileId);
    const now = new Date();
    const rows = await this.prisma.interview.findMany({
      where: {
        business_id: businessId,
        ...(filter.cvResumeId ? { cv_resume_id: filter.cvResumeId } : {}),
        ...(filter.applicationId
          ? { application_id: filter.applicationId }
          : {}),
        ...(filter.externalApplicationId
          ? { external_application_id: filter.externalApplicationId }
          : {}),
        ...(filter.scope === 'upcoming'
          ? { starts_at: { gte: new Date(now.getTime() - 2 * 60 * 60 * 1000) } }
          : filter.scope === 'past'
            ? {
                starts_at: { lt: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
              }
            : {}),
      },
      // Upcoming soonest first; otherwise the newest: unscoped, the 200
      // oldest came back and recent interviews went missing from the cards.
      orderBy: { starts_at: filter.scope === 'upcoming' ? 'asc' : 'desc' },
      take: 200,
    });
    return rows.map(view);
  }

  /** Moves an interview (date, format, place, message): sent again, waiting for a new answer. */
  async reschedule(
    profileId: string,
    id: string,
    input: Omit<
      InterviewInput,
      'cvResumeId' | 'applicationId' | 'candidateEmail'
    >,
  ) {
    const interview = await this.owned(profileId, id);
    if (interview.status === InterviewStatus.CANCELLED) {
      throw new BadRequestException('Cet entretien est annulé.');
    }
    const token = randomBytes(24).toString('base64url');
    const slot = this.slot(input);
    const updated = await this.prisma.interview.update({
      where: { id: interview.id },
      data: {
        ...slot.fields,
        // The times offered before go; the new ones, if several, replace them.
        slots: {
          deleteMany: {},
          ...(slot.options.length > 1
            ? { create: slot.options.map((d) => ({ starts_at: d })) }
            : {}),
        },
        status: InterviewStatus.PENDING,
        response_note: null,
        responded_at: null,
        reminded_at: soon(slot.fields.starts_at) ? new Date() : null,
        // A new link: the old e-mail's answers would be about the old time.
        token_hash: hashToken(token),
      },
      include: LOAD,
    });
    await this.invite(updated, token, true);
    return view(updated);
  }

  async cancel(profileId: string, id: string) {
    const interview = await this.owned(profileId, id);
    if (interview.status === InterviewStatus.CANCELLED) return view(interview);
    return view(await this.cancelAndTell(interview.id));
  }

  private async cancelAndTell(id: string) {
    const updated = await this.prisma.interview.update({
      where: { id },
      data: { status: InterviewStatus.CANCELLED },
      include: LOAD,
    });
    const loaded = updated;
    const mail = this.mailOf(loaded);
    const to = this.candidateEmail(loaded);
    if (to) {
      await this.send(
        to,
        `Entretien annulé — ${loaded.job_title}`,
        interviewCancelledEmail(mail),
        [this.icsAttachment(loaded, true)],
      );
    }
    if (loaded.application) {
      notifyProfile(this.events, {
        recipientId: loaded.application.worker.id,
        input: {
          type: 'INTERVIEW_CANCELLED',
          applicationId: loaded.application_id!,
          businessName: loaded.business.name,
          jobTitle: loaded.job_title,
          when: frWhen(loaded.starts_at),
        },
      });
    }
    return updated;
  }

  /**
   * Interviews whose candidate is out: refused, or closed along with the offer.
   * Follows the application, not the offer: an uploaded CV has none, and a
   * business may well interview those after the offer's date.
   */
  async closeEnded(now = new Date()): Promise<number> {
    const stale = await this.prisma.interview.findMany({
      where: {
        status: {
          in: [
            InterviewStatus.PENDING,
            InterviewStatus.CONFIRMED,
            InterviewStatus.RESCHEDULE_REQUESTED,
          ],
        },
        starts_at: { gt: now },
        OR: [
          {
            application: {
              status: {
                in: [ApplicationStatus.REJECTED, ApplicationStatus.CANCELLED],
              },
            },
          },
          {
            cv_resume: {
              external_application: {
                status: ExternalApplicationStatus.REFUSED,
              },
            },
          },
        ],
      },
      select: { id: true },
      take: 200,
    });
    for (const { id } of stale) await this.cancelAndTell(id);
    return stale.length;
  }

  // ── The candidate, through the private link ──────────────────────────

  async byToken(token: string) {
    const interview = await this.prisma.interview.findUnique({
      where: { token_hash: hashToken(token) },
      include: LOAD,
    });
    if (!interview)
      throw new NotFoundException(
        'Invitation introuvable ou remplacée par une plus récente.',
      );
    return publicView(interview);
  }

  async respond(
    token: string,
    answer: InterviewAnswer,
    note?: string | null,
    slotId?: string | null,
  ) {
    const interview = await this.prisma.interview.findUnique({
      where: { token_hash: hashToken(token) },
      include: LOAD,
    });
    if (!interview)
      throw new NotFoundException(
        'Invitation introuvable ou remplacée par une plus récente.',
      );
    if (interview.status === InterviewStatus.CANCELLED) {
      throw new BadRequestException('Cet entretien a été annulé.');
    }
    // With times to choose from, it is past only once the last one is.
    const lastTime =
      slotsOf(interview).at(-1)?.starts_at ?? interview.starts_at;
    if (lastTime.getTime() < Date.now()) {
      throw new BadRequestException('Cet entretien est passé.');
    }
    const clean = note?.trim().slice(0, 1000) || null;
    // Several times offered: confirming is choosing one of them.
    const chosen =
      answer === 'CONFIRMED' && slotsOf(interview).length > 0
        ? slotsOf(interview).find((x) => x.id === slotId)
        : undefined;
    if (answer === 'CONFIRMED' && slotsOf(interview).length > 0) {
      if (!chosen) {
        throw new BadRequestException('Choisissez l’un des créneaux proposés.');
      }
      if (chosen.starts_at.getTime() < Date.now()) {
        throw new BadRequestException(
          'Ce créneau est passé : choisissez-en un autre.',
        );
      }
    }
    if (answer === 'RESCHEDULE_REQUESTED' && !clean) {
      throw new BadRequestException(
        'Indiquez les moments qui vous conviennent.',
      );
    }
    // The same answer again: nothing to tell the recruiter.
    if (interview.status === answer && interview.response_note === clean) {
      return publicView(interview);
    }
    // One change of mind every few minutes: each one e-mails the business.
    if (
      interview.responded_at &&
      Date.now() - interview.responded_at.getTime() < ANSWER_COOLDOWN_MS
    ) {
      throw new HttpException(
        'Vous venez de répondre : patientez quelques minutes avant de changer votre réponse.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const updated = await this.prisma.interview.update({
      where: { id: interview.id },
      data: {
        status: answer,
        response_note: clean,
        responded_at: new Date(),
        // The time chosen becomes the interview's; the others go.
        ...(chosen
          ? {
              starts_at: chosen.starts_at,
              slots: { deleteMany: {} },
              reminded_at: soon(chosen.starts_at) ? new Date() : null,
            }
          : {}),
      },
      include: LOAD,
    });
    // The chosen time, now settled, goes into the candidate's agenda.
    if (chosen) {
      const to = this.candidateEmail(updated);
      if (to) {
        await this.send(
          to,
          `Entretien confirmé — ${updated.job_title}`,
          interviewChosenEmail(this.mailOf(updated)),
          [this.icsAttachment(updated, false)],
        );
      }
    }

    const when = frWhen(updated.starts_at);
    notifyProfile(this.events, {
      recipientId: updated.business.profile_id,
      input: {
        type: 'INTERVIEW_ANSWERED',
        applicationId: updated.application_id,
        candidateName: updated.candidate_name,
        jobTitle: updated.job_title,
        when,
        answer,
      },
    });
    await this.sendToBusiness(
      updated.business.profile_id,
      `${updated.candidate_name} — ${answer === 'CONFIRMED' ? 'entretien confirmé' : answer === 'DECLINED' ? 'entretien décliné' : 'autre moment demandé'}`,
      interviewAnsweredEmail(this.mailOf(updated), answer, clean),
    );
    return publicView(updated);
  }

  // ── The day before ───────────────────────────────────────────────────

  /** Reminds both sides of the interviews in the next 24 hours, once. */
  async remind(now = new Date()): Promise<number> {
    const due = (await this.prisma.interview.findMany({
      where: {
        status: { in: [InterviewStatus.PENDING, InterviewStatus.CONFIRMED] },
        reminded_at: null,
        starts_at: { gt: now, lte: new Date(now.getTime() + DAY_MS) },
        // No reminder of a time the candidate has not chosen yet.
        slots: { none: {} },
      },
      include: LOAD,
      take: 200,
    })) as Loaded[];
    let sent = 0;
    for (const interview of due) {
      const { count } = await this.prisma.interview.updateMany({
        where: { id: interview.id, reminded_at: null },
        data: { reminded_at: now },
      });
      if (count === 0) continue;
      const mail = this.mailOf(interview);
      const to = this.candidateEmail(interview);
      if (to) {
        await this.send(
          to,
          `Rappel : entretien demain — ${interview.job_title}`,
          interviewReminderEmail(mail, 'candidate'),
        );
      }
      await this.sendToBusiness(
        interview.business.profile_id,
        `Rappel : entretien avec ${interview.candidate_name} demain`,
        interviewReminderEmail(mail, 'business'),
      );
      sent++;
    }
    return sent;
  }

  // ── Inside ───────────────────────────────────────────────────────────

  private slot(
    input: Pick<
      InterviewInput,
      | 'startsAt'
      | 'options'
      | 'durationMinutes'
      | 'mode'
      | 'location'
      | 'message'
    >,
  ) {
    // One time, or 2 to 3 to choose from (sorted, without twins).
    const raw = input.options?.length
      ? input.options
      : input.startsAt
        ? [input.startsAt]
        : [];
    if (raw.length > MAX_INTERVIEW_OPTIONS) {
      throw new BadRequestException(
        `${MAX_INTERVIEW_OPTIONS} créneaux au plus.`,
      );
    }
    const times = [...new Set(raw)]
      .map((t) => new Date(t))
      .sort((a, b) => a.getTime() - b.getTime());
    if (
      times.length === 0 ||
      times.some(
        (t) =>
          Number.isNaN(t.getTime()) || t.getTime() < Date.now() + MIN_LEAD_MS,
      )
    ) {
      throw new BadRequestException('Choisissez une date à venir.');
    }
    const startsAt = times[0];
    if (!INTERVIEW_DURATIONS.includes(input.durationMinutes)) {
      throw new BadRequestException('Durée non prise en charge.');
    }
    const location = input.location?.trim() || null;
    if (input.mode === InterviewMode.IN_PERSON && !location) {
      throw new BadRequestException('Indiquez l’adresse de l’entretien.');
    }
    if (
      input.mode === InterviewMode.VIDEO &&
      !(location && /^https?:\/\/\S+$/i.test(location))
    ) {
      throw new BadRequestException(
        'Collez le lien de la visio (Meet, Zoom, WhatsApp…), commençant par https://',
      );
    }
    return {
      fields: {
        starts_at: startsAt,
        duration_minutes: input.durationMinutes,
        mode: input.mode,
        location: location?.slice(0, 500) ?? null,
        message: input.message?.trim().slice(0, 2000) || null,
      },
      options: times,
    };
  }

  /** The Rabotka application a CV of this business was analysed for, if any. */
  private async applicationOfResume(
    businessId: string,
    resumeId: string,
  ): Promise<string | null> {
    const app = await this.prisma.application.findFirst({
      where: {
        cv_resume_id: resumeId,
        cv_resume: { screening: { business_id: businessId } },
      },
      select: { id: true },
    });
    return app?.id ?? null;
  }

  private async fromCv(
    businessId: string,
    resumeId: string,
    email?: string | null,
  ) {
    const resume = await this.prisma.cvScreeningResume.findFirst({
      where: { id: resumeId, screening: { business_id: businessId } },
      include: { screening: { select: { job_title: true, offer_id: true } } },
    });
    if (!resume) throw new NotFoundException('CV introuvable.');
    if (resume.status !== CvScreeningResumeStatus.SCORED) {
      throw new BadRequestException('Ce CV n’a pas pu être lu.');
    }
    const refused = await this.prisma.externalApplication.findFirst({
      where: {
        cv_resume_id: resumeId,
        status: ExternalApplicationStatus.REFUSED,
      },
      select: { id: true },
    });
    if (refused) {
      throw new BadRequestException(
        'Cette candidature a été refusée : pas d’entretien.',
      );
    }
    const c = (resume.candidate ?? {}) as {
      name?: string | null;
      email?: string | null;
    };
    const to = (email?.trim() || c.email?.trim() || '').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      throw new BadRequestException(
        'Indiquez l’e-mail du candidat : l’invitation lui est envoyée par e-mail.',
      );
    }
    return {
      name: c.name?.trim() || 'Candidat',
      email: to,
      jobTitle: resume.screening.job_title,
      offerId: resume.screening.offer_id,
    };
  }

  /** A careers-page candidate, with or without a CV analysis. */
  private async fromExternal(profileId: string, id: string) {
    const application = await this.prisma.externalApplication.findFirst({
      where: { id, job_offer: { employer_id: profileId } },
      include: {
        job_offer: { select: { id: true, title: true, status: true } },
      },
    });
    if (!application) throw new NotFoundException('Candidature introuvable.');
    if (isTerminalJobOfferStatus(application.job_offer.status)) {
      throw new BadRequestException('Cette offre ne recrute plus.');
    }
    if (application.status === ExternalApplicationStatus.REFUSED) {
      throw new BadRequestException(
        'Cette candidature a été refusée : pas d’entretien.',
      );
    }
    return {
      name: `${application.first_name} ${application.last_name}`.trim(),
      email: application.email.trim().toLowerCase(),
      jobTitle: application.job_offer.title,
      offerId: application.job_offer.id,
    };
  }

  private async fromApplication(profileId: string, applicationId: string) {
    const application = await this.prisma.application.findFirst({
      where: {
        id: applicationId,
        job_offer: { employer_id: profileId },
        deleted_at: null,
      },
      include: {
        job_offer: { select: { id: true, title: true, status: true } },
        worker: { select: { first_name: true, last_name: true } },
      },
    });
    if (!application) throw new NotFoundException('Candidature introuvable.');
    if (isTerminalJobOfferStatus(application.job_offer.status)) {
      throw new BadRequestException('Cette offre ne recrute plus.');
    }
    // Refused or withdrawn: invited, then cancelled 15 minutes later.
    if (
      application.status === ApplicationStatus.REJECTED ||
      application.status === ApplicationStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'Cette candidature a été refusée ou retirée : pas d’entretien.',
      );
    }
    return {
      name: `${application.worker.first_name} ${application.worker.last_name}`.trim(),
      // Read at send time from the profile: never kept where the business reads.
      email: null,
      jobTitle: application.job_offer.title,
      offerId: application.job_offer.id,
    };
  }

  private async invite(interview: Loaded, token: string, changed: boolean) {
    const mail = this.mailOf(interview);
    const to = this.candidateEmail(interview);
    const options = slotsOf(interview).map((x) => x.starts_at);
    if (to) {
      await this.send(
        to,
        `${changed ? 'Entretien modifié' : 'Invitation à un entretien'} — ${interview.job_title}`,
        interviewInviteEmail(mail, answerUrl(token), changed, options),
        // No agenda file while the time is to choose: it comes once chosen.
        options.length > 0 ? [] : [this.icsAttachment(interview, false)],
      );
    }
    if (interview.application) {
      notifyProfile(this.events, {
        recipientId: interview.application.worker.id,
        input: {
          type: 'INTERVIEW_INVITED',
          applicationId: interview.application_id!,
          businessName: interview.business.name,
          jobTitle: interview.job_title,
          when:
            options.length > 0
              ? `${options.length} créneaux au choix`
              : frWhen(interview.starts_at),
          changed,
        },
      });
    }
  }

  private candidateEmail(interview: Loaded): string | null {
    return interview.application
      ? interview.application.worker.email
      : interview.candidate_email;
  }

  private mailOf(interview: Loaded): InterviewMail {
    return {
      businessName: interview.business.name,
      jobTitle: interview.job_title,
      candidateName: interview.candidate_name,
      startsAt: interview.starts_at,
      durationMinutes: interview.duration_minutes,
      mode: interview.mode,
      location: interview.location,
      message: interview.message,
    };
  }

  private icsAttachment(interview: Loaded, cancelled: boolean) {
    return {
      filename: 'entretien.ics',
      contentType: `text/calendar; charset=utf-8; method=${cancelled ? 'CANCEL' : 'REQUEST'}`,
      content: interviewIcs({
        uid: interview.id,
        // Each change outranks the last one in the candidate's calendar.
        sequence: Math.floor(interview.updated_at.getTime() / 1000),
        startsAt: interview.starts_at,
        durationMinutes: interview.duration_minutes,
        summary: `Entretien — ${interview.job_title} (${interview.business.name})`,
        description:
          interview.message ?? `Entretien avec ${interview.business.name}.`,
        location: interview.location,
        organizerName: interview.business.name,
        cancelled,
      }),
    };
  }

  /**
   * To the team, as its other recruiting e-mails: the holder and every member
   * who left them on — the Recruteur who booked the interview included.
   */
  private async sendToBusiness(
    profileId: string,
    subject: string,
    content: string,
  ) {
    const recipients = await businessEmailRecipientsOfProfile(
      this.prisma,
      profileId,
      'recruiting',
    ).catch(() => []);
    for (const r of recipients) {
      await this.send(r.email, subject, content, [], true);
    }
  }

  private async send(
    to: string | null | undefined,
    subject: string,
    content: string,
    attachments: {
      filename: string;
      content: string;
      contentType: string;
    }[] = [],
    business = false,
  ) {
    if (!to) return;
    try {
      await this.mail.sendMail({
        to,
        subject,
        html: await this.layout.wrap(content, {
          previewText: subject,
          ...(business ? { product: 'business' as const } : {}),
        }),
        attachments,
      });
    } catch (err) {
      this.logger.warn(
        `Interview mail to ${to} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async owned(profileId: string, id: string): Promise<Interview> {
    const businessId = await this.businessOf(profileId);
    const interview = await this.prisma.interview.findFirst({
      where: { id, business_id: businessId },
    });
    if (!interview) throw new NotFoundException('Entretien introuvable.');
    return interview;
  }

  private async businessOf(profileId: string): Promise<string> {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId)
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    return businessId;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function answerUrl(token: string): string {
  return `${businessDashboardUrl().replace(/\/espace$/, '')}/entretien/${token}`;
}

/** For the business. An applicant's e-mail is never part of it. */
/** One change of answer per candidate in this time: each e-mails the business. */
const ANSWER_COOLDOWN_MS = 10 * 60 * 1000;

/** The times still offered, sorted; none when the row was read without them. */
function slotsOf(i: { slots?: unknown }): { id: string; starts_at: Date }[] {
  return Array.isArray(i.slots)
    ? (i.slots as { id: string; starts_at: Date }[])
    : [];
}

/** Under a day away: the invitation already serves as the reminder. */
function soon(startsAt: Date): boolean {
  return startsAt.getTime() - Date.now() < DAY_MS;
}

function view(i: Interview & { slots?: { id: string; starts_at: Date }[] }) {
  return {
    /** Times still to choose from (several offered); empty once chosen. */
    options: slotsOf(i).map((x) => ({
      id: x.id,
      startsAt: x.starts_at.toISOString(),
    })),
    id: i.id,
    cvResumeId: i.cv_resume_id,
    externalApplicationId: i.external_application_id,
    applicationId: i.application_id,
    offerId: i.offer_id,
    jobTitle: i.job_title,
    candidateName: i.candidate_name,
    candidateEmail: i.application_id ? null : i.candidate_email,
    startsAt: i.starts_at.toISOString(),
    durationMinutes: i.duration_minutes,
    mode: i.mode,
    location: i.location,
    message: i.message,
    status: i.status,
    responseNote: i.response_note,
    respondedAt: i.responded_at?.toISOString() ?? null,
    createdAt: i.created_at.toISOString(),
  };
}

/** For the candidate's page: what they need to answer, nothing about the business's other data. */
function publicView(i: Loaded) {
  return {
    businessName: i.business.name,
    businessLogoUrl: i.business.profile.avatar_url,
    jobTitle: i.job_title,
    candidateName: i.candidate_name,
    startsAt: i.starts_at.toISOString(),
    durationMinutes: i.duration_minutes,
    mode: i.mode,
    location: i.location,
    message: i.message,
    status: i.status,
    responseNote: i.response_note,
    /** Times to choose from; empty for one time, or once chosen. */
    options: slotsOf(i)
      .filter((x) => x.starts_at.getTime() >= Date.now())
      .map((x) => ({ id: x.id, startsAt: x.starts_at.toISOString() })),
    past: (slotsOf(i).at(-1)?.starts_at ?? i.starts_at).getTime() < Date.now(),
  };
}
