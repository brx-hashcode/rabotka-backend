import {
  BadRequestException,
  ForbiddenException,
  Injectable,
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
import { answerSnippet } from '../cv-screening/lenient-answer';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import { businessEmailRecipients } from '../team/business-recipients';
import { frWhen } from './interview-emails';
import {
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

  /** Writes (or writes again) the report from the notes saved. */
  async write(actor: Actor, interviewId: string) {
    const { interview } = await this.owned(actor, interviewId);
    const notes = interview.report?.notes.trim() ?? '';
    if (notes.length < MIN_NOTES) {
      throw new BadRequestException(
        'Prenez d’abord quelques notes sur l’entretien : le compte rendu est rédigé à partir d’elles.',
      );
    }
    const messages: BaseMessage[] = reportMessages(
      await this.context(interview, notes),
    );
    const correlationId = `interview-report:${interview.id}`;
    const ask = async (input: BaseMessage[]) => {
      const { output } = await this.llm.invoke(input, {
        tier: 'writing',
        timeoutMs: LLM_TIMEOUT_MS,
        correlationId,
      });
      return contentText(output.content);
    };
    let report: InterviewReportBody | null = null;
    try {
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
    if (!report) {
      throw new ServiceUnavailableException(
        'Le compte rendu n’a pas pu être rédigé : réessayez dans un instant.',
      );
    }
    const saved = await this.prisma.interviewReport.update({
      where: { interview_id: interview.id },
      data: {
        report: report,
        generated_at: new Date(),
        updated_by_member_id: actor.memberId ?? null,
      },
    });
    return view(saved);
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
        when: frWhen(interview.starts_at),
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

  /** What the AI may know beside the notes: the offer, the form, the CV. */
  private async context(
    i: {
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
    return {
      jobTitle: i.job_title,
      businessName: i.business.name,
      candidateName: i.candidate_name,
      when: frWhen(i.starts_at),
      mode: MODES[i.mode],
      durationMinutes: i.duration_minutes,
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

function view(
  r: {
    notes: string;
    report: Prisma.JsonValue | null;
    generated_at: Date | null;
    sent_at: Date | null;
    updated_at: Date;
  } | null,
) {
  return {
    notes: r?.notes ?? '',
    report: r?.report ? cleanReport(r.report) : null,
    generatedAt: r?.generated_at?.toISOString() ?? null,
    sentAt: r?.sent_at?.toISOString() ?? null,
    updatedAt: r?.updated_at.toISOString() ?? null,
  };
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
