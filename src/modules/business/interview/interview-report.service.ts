import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { LayoutService } from '../../mail/layout.service';
import { businessDashboardUrl } from '../../mail/audience';
import { LlmService } from '../../rag/llm/llm.service';
import { InterviewTranscriptService } from './interview-transcript.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { QueueService } from '../../../common/services/queue/queue.service';
import { INTERVIEW_REPORT_QUEUE } from '../../../common/services/queue/queue.module';
import { notifyProfile } from '../../profile-notification/profile-notification.events';
import { htmlToPdf } from '../../../common/utils/puppeteer';
import { rabotkaLogoDataUri } from '../../../common/utils/rabotka-logo';
import { answerSnippet } from '../cv-screening/lenient-answer';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import { businessEmailRecipients } from '../team/business-recipients';
import { heldWhen } from './interview-emails';
import {
  buildInterviewReportHtml,
  cleanReport,
  interviewReportEmail,
  MAX_NOTES,
  MIN_NOTES,
  parseReport,
  REPORT_JSON_REMINDER,
  reportMessages,
  type InterviewReportBody,
  type ReportContext,
} from './interview-report';

const MODES = {
  IN_PERSON: 'en personne',
  PHONE: 'par téléphone',
  VIDEO: 'en visio',
} as const;
const LLM_TIMEOUT_MS = 45_000;
/** Two model calls at most: past this, a writing still marked is a lost job. */
const WRITING_STALE_MS = 3 * 60_000;

export type InterviewReportJob = {
  interviewId: string;
  memberId: string | null;
};

type Actor = { profileId: string; memberId?: string };

/**
 * « Compte rendu » of an interview: the team's notes, autosaved, and the
 * report the AI writes from them, which the team edits, sends or prints.
 */
@Injectable()
export class InterviewReportService {
  private readonly logger = new Logger(InterviewReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly llm: LlmService,
    private readonly mail: MailService,
    private readonly layout: LayoutService,
    private readonly transcripts: InterviewTranscriptService,
    private readonly queue: QueueService,
    private readonly events: EventEmitter2,
  ) {}

  async get(actor: Actor, interviewId: string) {
    const { interview } = await this.owned(actor, interviewId);
    return view(interview.report);
  }

  async saveNotes(actor: Actor, interviewId: string, notes: string) {
    const { businessId } = await this.owned(actor, interviewId);
    const clean = (notes ?? '').slice(0, MAX_NOTES);
    const saved = await this.prisma.interviewReport.upsert({
      where: { interview_id: interviewId },
      create: {
        interview_id: interviewId,
        business_id: businessId,
        notes: clean,
        updated_by_member_id: actor.memberId ?? null,
      },
      update: { notes: clean, updated_by_member_id: actor.memberId ?? null },
    });
    return view(saved);
  }

  /**
   * « Rédiger le compte rendu »: checked here, written in the background
   * (generate, by the report queue), a notification when it is ready. Asked
   * again while it is being written: nothing more is queued.
   */
  async write(actor: Actor, interviewId: string) {
    const { interview } = await this.owned(actor, interviewId);
    const notes = interview.report?.notes.trim() ?? '';
    const transcript = await this.transcripts.merged(interview.id);
    if (notes.length < MIN_NOTES && transcript.length < MIN_NOTES) {
      throw new BadRequestException(
        'Prenez d’abord quelques notes sur l’entretien, ou transcrivez-le : le compte rendu est rédigé à partir d’elles.',
      );
    }
    if (interview.report && writing(interview.report)) {
      return view(interview.report);
    }
    const saved = await this.prisma.interviewReport.upsert({
      where: { interview_id: interview.id },
      create: {
        interview_id: interview.id,
        business_id: interview.business_id,
        writing_started_at: new Date(),
        writing_error: null,
      },
      update: { writing_started_at: new Date(), writing_error: null },
    });
    try {
      await this.queue.addJob<InterviewReportJob>(INTERVIEW_REPORT_QUEUE, {
        interviewId: interview.id,
        memberId: actor.memberId ?? null,
      });
    } catch (err) {
      await this.prisma.interviewReport.update({
        where: { interview_id: interview.id },
        data: { writing_started_at: null },
      });
      this.logger.error(`Interview report ${interview.id} not queued`, err);
      throw new ServiceUnavailableException(
        'Le compte rendu n’a pas pu être lancé : réessayez dans un instant.',
      );
    }
    return view(saved);
  }

  /** The report queue's job: writes it from the notes and the transcript, then tells the team. */
  async generate(job: InterviewReportJob): Promise<void> {
    const interview = await this.prisma.interview.findUnique({
      where: { id: job.interviewId },
      include: {
        report: true,
        business: { select: { name: true, profile_id: true } },
      },
    });
    if (!interview) return;
    const notes = interview.report?.notes.trim() ?? '';
    // Both sides' recognised speech, merged by time, when it was transcribed.
    const transcript = await this.transcripts.merged(interview.id);
    let report: InterviewReportBody | null = null;
    try {
      const messages: BaseMessage[] = reportMessages({
        ...(await this.context(interview, notes)),
        transcript,
      });
      const correlationId = `interview-report:${interview.id}`;
      const ask = async (input: BaseMessage[]) => {
        const { output } = await this.llm.invoke(input, {
          tier: 'writing',
          timeoutMs: LLM_TIMEOUT_MS,
          correlationId,
        });
        return contentText(output.content);
      };
      const first = await ask(messages);
      report = parseReport(first);
      if (!report) {
        const second = await ask([
          ...messages,
          new AIMessage(first),
          new HumanMessage(REPORT_JSON_REMINDER),
        ]);
        report = parseReport(second);
        if (!report) {
          this.logger.warn(
            `Interview report ${interview.id} unreadable: ${answerSnippet(second)}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Interview report ${interview.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.prisma.interviewReport.upsert({
      where: { interview_id: interview.id },
      create: {
        interview_id: interview.id,
        business_id: interview.business_id,
        ...(report ? { report, generated_at: new Date() } : {}),
        writing_started_at: null,
        writing_error: report
          ? null
          : 'Le compte rendu n’a pas pu être rédigé : réessayez dans un instant.',
        updated_by_member_id: job.memberId,
      },
      update: {
        ...(report ? { report, generated_at: new Date() } : {}),
        writing_started_at: null,
        writing_error: report
          ? null
          : 'Le compte rendu n’a pas pu être rédigé : réessayez dans un instant.',
        updated_by_member_id: job.memberId,
      },
    });
    notifyProfile(this.events, {
      recipientId: interview.business.profile_id,
      input: {
        type: 'INTERVIEW_REPORT_READY',
        interviewId: interview.id,
        candidateName: interview.candidate_name,
        jobTitle: interview.job_title,
        ok: Boolean(report),
      },
    });
  }

  /** The team's own changes to the sections. */
  async edit(actor: Actor, interviewId: string, input: unknown) {
    const { interview } = await this.owned(actor, interviewId);
    if (!interview.report?.report) {
      throw new BadRequestException('Rédigez d’abord le compte rendu.');
    }
    const report = cleanReport(input);
    if (!report) throw new BadRequestException('Compte rendu invalide.');
    const saved = await this.prisma.interviewReport.update({
      where: { interview_id: interview.id },
      data: {
        report: report,
        updated_by_member_id: actor.memberId ?? null,
      },
    });
    return view(saved);
  }

  /**
   * By e-mail to the team: those chosen, or the members who receive the
   * hiring e-mails. Never outside the team, never WhatsApp.
   */
  async send(actor: Actor, interviewId: string, memberIds?: string[]) {
    const { interview, businessId } = await this.owned(actor, interviewId);
    const report = interview.report?.report
      ? cleanReport(interview.report.report)
      : null;
    if (!report)
      throw new BadRequestException('Rédigez d’abord le compte rendu.');

    const recipients = memberIds?.length
      ? await this.prisma.businessMember.findMany({
          where: {
            business_id: businessId,
            id: { in: memberIds.slice(0, 50) },
            status: 'ACTIVE',
          },
          select: { email: true },
        })
      : await businessEmailRecipients(this.prisma, businessId, 'recruiting');
    const emails = [...new Set(recipients.map((r) => r.email.toLowerCase()))];
    if (emails.length === 0) {
      throw new BadRequestException('Aucun destinataire dans votre équipe.');
    }
    const html = await this.layout.wrap(
      interviewReportEmail(report, {
        candidateName: interview.candidate_name,
        jobTitle: interview.job_title,
        when: (await this.held(interview)).when,
        url: `${businessDashboardUrl()}/entretiens?onglet=passes`,
      }),
      {
        previewText: `Compte rendu — ${interview.candidate_name}`,
        product: 'business',
      },
    );
    let sent = 0;
    for (const to of emails) {
      try {
        await this.mail.sendMail({
          to,
          subject: `Compte rendu d’entretien — ${interview.candidate_name} (${interview.job_title})`,
          html,
        });
        sent++;
      } catch (err) {
        this.logger.warn(
          `Interview report mail to ${to} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (sent === 0) {
      throw new ServiceUnavailableException(
        'L’envoi a échoué : réessayez dans un instant.',
      );
    }
    const saved = await this.prisma.interviewReport.update({
      where: { interview_id: interview.id },
      data: { sent_at: new Date() },
    });
    return { ...view(saved), sentTo: sent };
  }

  /** The report as a Rabotka A4 document, to read, download or print. */
  async pdf(actor: Actor, interviewId: string) {
    const { interview } = await this.owned(actor, interviewId);
    const report = interview.report?.report
      ? cleanReport(interview.report.report)
      : null;
    if (!report)
      throw new BadRequestException('Rédigez d’abord le compte rendu.');
    const html = buildInterviewReportHtml({
      report,
      businessName: interview.business.name,
      candidateName: interview.candidate_name,
      jobTitle: interview.job_title,
      ...(await this.held(interview).then((h) => ({
        when: h.when,
        durationMinutes: h.minutes ?? interview.duration_minutes,
      }))),
      mode: MODES[interview.mode].replace(/^./, (c) => c.toUpperCase()),
      generatedAt: (
        interview.report?.generated_at ?? new Date()
      ).toLocaleDateString('fr-FR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'Africa/Brazzaville',
      }),
      logo: rabotkaLogoDataUri(),
    });
    try {
      return {
        buffer: await htmlToPdf(html, 'Compte rendu d’entretien'),
        filename: `compte-rendu-${slug(interview.candidate_name)}.pdf`,
      };
    } catch (err) {
      this.logger.error(
        'Interview report PDF failed',
        err instanceof Error ? err.stack : String(err),
      );
      throw new InternalServerErrorException(
        'Le document n’a pas pu être créé. Réessayez dans un instant.',
      );
    }
  }

  // ── Inside ───────────────────────────────────────────────────────────

  private async owned(actor: Actor, interviewId: string) {
    const businessId = await this.subscriptions.businessOf(actor.profileId);
    if (!businessId)
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    const interview = await this.prisma.interview.findFirst({
      where: { id: interviewId, business_id: businessId },
      include: { report: true, business: { select: { name: true } } },
    });
    if (!interview) throw new NotFoundException('Entretien introuvable.');
    return { interview, businessId };
  }

  /**
   * The times the interview really ran: from the business joining the call
   * (or the first sentence) to « Terminer » (or the last sentence).
   */
  private async held(i: {
    id: string;
    starts_at: Date;
    call_started_at?: Date | null;
    ended_at?: Date | null;
  }) {
    const span = await this.transcripts.span(i.id);
    const starts = [i.call_started_at, span.first].filter(
      (d): d is Date => !!d,
    );
    const start = starts.length
      ? new Date(Math.min(...starts.map((d) => d.getTime())))
      : null;
    return heldWhen(i.starts_at, start, i.ended_at ?? span.last);
  }

  /** The business joined the call: its real start, kept once. */
  async markStarted(actor: Actor, interviewId: string) {
    const { interview } = await this.owned(actor, interviewId);
    if (!interview.call_started_at && !interview.ended_at) {
      await this.prisma.interview.update({
        where: { id: interview.id },
        data: { call_started_at: new Date() },
      });
    }
    return { started: true };
  }

  /** What the AI may know beside the notes: the offer, the form, the CV. */
  private async context(
    i: {
      id: string;
      call_started_at?: Date | null;
      ended_at?: Date | null;
      job_title: string;
      candidate_name: string;
      starts_at: Date;
      mode: keyof typeof MODES;
      duration_minutes: number;
      offer_id: string | null;
      application_id: string | null;
      external_application_id: string | null;
      cv_resume_id: string | null;
      business: { name: string };
    },
    notes: string,
  ): Promise<ReportContext> {
    const [offer, application, external] = await Promise.all([
      i.offer_id
        ? this.prisma.jobOffer.findUnique({
            where: { id: i.offer_id },
            select: { description: true },
          })
        : null,
      i.application_id
        ? this.prisma.application.findUnique({
            where: { id: i.application_id },
            select: {
              cv_resume_id: true,
              answers: { select: { label: true, value: true } },
            },
          })
        : null,
      i.external_application_id
        ? this.prisma.externalApplication.findUnique({
            where: { id: i.external_application_id },
            select: { cv_resume_id: true, answers: true },
          })
        : null,
    ]);
    const resumeId =
      i.cv_resume_id ??
      application?.cv_resume_id ??
      external?.cv_resume_id ??
      null;
    const resume = resumeId
      ? await this.prisma.cvScreeningResume.findUnique({
          where: { id: resumeId },
          select: { summary: true, strengths: true, gaps: true },
        })
      : null;
    const answers = application
      ? application.answers
      : Array.isArray(external?.answers)
        ? (external.answers as { label?: unknown; value?: unknown }[])
            .filter(
              (a): a is { label: string; value: string } =>
                typeof a?.label === 'string' && typeof a?.value === 'string',
            )
            .map(({ label, value }) => ({ label, value }))
        : [];
    const held = await this.held(i);
    return {
      jobTitle: i.job_title,
      businessName: i.business.name,
      candidateName: i.candidate_name,
      when: held.when,
      mode: MODES[i.mode],
      durationMinutes: held.minutes ?? i.duration_minutes,
      offerDescription: offer?.description ?? null,
      answers,
      cv: resume
        ? {
            summary: resume.summary,
            strengths: resume.strengths,
            gaps: resume.gaps,
          }
        : null,
      notes,
    };
  }
}

/** Being written, unless it was asked so long ago that the job is lost. */
function writing(r: { writing_started_at?: Date | null }): boolean {
  return (
    !!r.writing_started_at &&
    Date.now() - r.writing_started_at.getTime() < WRITING_STALE_MS
  );
}

function view(
  r: {
    notes: string;
    report: Prisma.JsonValue | null;
    generated_at: Date | null;
    sent_at: Date | null;
    updated_at: Date;
    writing_started_at?: Date | null;
    writing_error?: string | null;
  } | null,
) {
  return {
    notes: r?.notes ?? '',
    report: r?.report ? cleanReport(r.report) : null,
    /** Written in the background right now: the page waits, a notification follows. */
    writing: r ? writing(r) : false,
    writingError: r?.writing_error ?? null,
    generatedAt: r?.generated_at?.toISOString() ?? null,
    sentAt: r?.sent_at?.toISOString() ?? null,
    updatedAt: r?.updated_at.toISOString() ?? null,
  };
}

function slug(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'candidat'
  );
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        typeof part === 'string'
          ? part
          : part &&
              typeof part === 'object' &&
              'text' in part &&
              typeof part.text === 'string'
            ? part.text
            : '',
      )
      .join('');
  }
  return '';
}
