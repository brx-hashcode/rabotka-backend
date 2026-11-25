import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  CvChatRole,
  CvScreeningResumeStatus,
  type CvScreeningResume,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  BusinessSubscriptionService,
  TRIAL_AI_REFUSAL,
} from '../subscription/business-subscription.service';
import {
  ANSWER_STYLE,
  CHAT_RULES,
  CvChatService,
  READY,
  chatLanguage,
  chatPrompt,
  HISTORY_TURNS,
  careerOf,
  usable,
  reportCandidate,
  view,
} from './cv-chat.service';
import type { OutputLanguage } from '../output-language';
import { CvRestoreService, type CvAvailability } from './cv-restore.service';
import { answersBlock, readApplicationAnswers } from './cv-assessment';
import type { ChatReportInput } from './cv-chat-report';
import {
  chartTools,
  criteriaLine,
  WITH_GRID,
  type ChartResume,
  type OnGrid,
} from './cv-chart';

export const MIN_COMPARED = 2;
export const MAX_COMPARED = 5;
/** Each CV's share of the prompt: five full CVs would drown the question. */
const CV_CHARS_EACH = 6_000;

const SYSTEM_PROMPT = [
  "Tu es l'assistant d'un recruteur, expert du recrutement en Afrique. Il compare PLUSIEURS candidats pour UN poste dans son pays, d'après leurs CV.",
  'Appuie-toi uniquement sur les CV, l’offre, les analyses et les réponses des candidats aux questions de l’offre (déclarées par eux : à confronter au CV). Nomme toujours les candidats par leur nom. Si une information manque dans un CV, dis-le plutôt que de la deviner.',
  'Commence par repérer les exigences essentielles de l’offre (métier, savoir-faire, expérience, lieu), puis juge chaque candidat sur ces exigences.',
  'Quand on te demande un classement ou qui retenir, tranche : une liste numérotée, du plus adapté au moins adapté ; pour chacun, son nom en **gras**, puis une ligne « pourquoi ce rang » avec ses atouts et ses manques précis tirés du CV, et s’il mérite un entretien.',
  'Si AUCUN candidat ne remplit les exigences essentielles, dis-le dès la première phrase : un classement entre profils inadaptés ne doit pas laisser croire que le premier convient. Indique alors lequel, au besoin, serait le moins éloigné et pourquoi, et conseille de chercher d’autres profils.',
  'Termine par une recommandation concrète : l’ordre des entretiens, et pour chacun le point à y vérifier.',
  '',
  ANSWER_STYLE,
  '',
  CHAT_RULES,
].join('\n');

export type CvCompareTurn = {
  language: OutputLanguage;
  comparisonId: string;
  messages: BaseMessage[];
  remaining: number;
  /** The question saved for this turn: the one taken back if nothing came. */
  questionId: string;
  /** The compared CVs, best first: what the charts are drawn from. */
  resumes: ChartResume[];
};

/**
 * One conversation comparing several analysed CVs of a screening, to settle
 * which candidates to see first. One per selection (choosing the same CVs
 * reopens it); the plan's questions per CV apply to it as a whole.
 */
@Injectable()
export class CvCompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly chat: CvChatService,
    private readonly restores: CvRestoreService,
  ) {}

  /** The conversation for these CVs, opened (or reopened) for the business. */
  async open(profileId: string, screeningId: string, resumeIds: string[]) {
    const ids = [...new Set(resumeIds)].sort();
    if (ids.length < MIN_COMPARED || ids.length > MAX_COMPARED) {
      throw new BadRequestException(
        `Choisissez de ${MIN_COMPARED} à ${MAX_COMPARED} CV à comparer.`,
      );
    }
    const { businessId, limit } = await this.business(profileId);
    const resumes = await this.prisma.cvScreeningResume.findMany({
      where: {
        id: { in: ids },
        screening: { id: screeningId, business_id: businessId },
      },
    });
    if (resumes.length !== ids.length) {
      throw new NotFoundException('CV introuvable.');
    }
    if (resumes.some((r) => r.status !== CvScreeningResumeStatus.SCORED)) {
      throw new BadRequestException(
        'Seuls les CV lus et classés peuvent être comparés.',
      );
    }
    const selection = ids.join(',');
    const comparison = await this.prisma.cvComparison.upsert({
      where: {
        screening_id_selection: { screening_id: screeningId, selection },
      },
      create: { screening_id: screeningId, resume_ids: ids, selection },
      update: {},
      include: { messages: { orderBy: { created_at: 'asc' } } },
    });
    const asked = comparison.messages.filter(
      (m) => m.role === CvChatRole.USER,
    ).length;
    const missing = await this.missing(resumes);
    return {
      id: comparison.id,
      resumeIds: ids,
      messages: comparison.messages.map(view),
      limit,
      remaining: Math.max(0, limit - asked),
      available: resumes.length - missing.length >= MIN_COMPARED,
      /** The CVs that cannot be compared any more, and why: the others are. */
      missing,
    };
  }

  /** The comparison's conversation, for its PDF. */
  async report(
    profileId: string,
    screeningId: string,
    comparisonId: string,
  ): Promise<ChatReportInput> {
    const { businessId } = await this.business(profileId);
    const comparison = await this.prisma.cvComparison.findFirst({
      where: {
        id: comparisonId,
        screening: { id: screeningId, business_id: businessId },
      },
      include: {
        screening: { include: { business: { select: { name: true } } } },
        messages: { orderBy: { created_at: 'asc' } },
      },
    });
    if (!comparison) throw new NotFoundException('Comparaison introuvable.');
    if (comparison.messages.length === 0) {
      throw new BadRequestException('Aucune question pour l’instant.');
    }
    const resumes = await this.prisma.cvScreeningResume.findMany({
      where: { id: { in: comparison.resume_ids } },
    });
    // Best first, as the analysis lists them.
    resumes.sort(
      (a, b) =>
        a.musts_missing - b.musts_missing || (b.score ?? -1) - (a.score ?? -1),
    );
    return {
      businessName: comparison.screening.business.name,
      jobTitle: comparison.screening.job_title,
      candidates: resumes.map((r, i) => reportCandidate(r, i + 1)),
      messages: comparison.messages.map((m) => ({
        role: m.role === CvChatRole.USER ? 'user' : 'assistant',
        content: m.content,
        createdAt: m.created_at,
      })),
      generatedAt: new Date(),
    };
  }

  /** Checked before the answer streams; the question saved, the prompt built. */
  async prepare(
    profileId: string,
    screeningId: string,
    comparisonId: string,
    question: string,
  ): Promise<CvCompareTurn> {
    const text = question.trim();
    if (text.length < 2) throw new BadRequestException('Posez votre question.');
    const { businessId, limit, trialLocked } = await this.business(profileId);
    const comparison = await this.prisma.cvComparison.findFirst({
      where: {
        id: comparisonId,
        screening: { id: screeningId, business_id: businessId },
      },
      include: {
        screening: true,
        messages: { orderBy: { created_at: 'asc' } },
      },
    });
    if (!comparison) throw new NotFoundException('Comparaison introuvable.');

    // Counted per CV, across every comparison it is in: counted per
    // comparison, each new group of the same CVs gave the questions again.
    const asked = await this.askedAbout(comparison.resume_ids);
    if (asked >= limit) {
      throw new ForbiddenException(
        trialLocked
          ? TRIAL_AI_REFUSAL
          : limit === 0
            ? 'La conversation avec les CV n’est pas incluse dans votre formule.'
            : `Vous avez posé les ${limit} questions prévues pour l’un de ces CV dans vos comparaisons.`,
      );
    }

    const all = await this.prisma.cvScreeningResume.findMany({
      where: { id: { in: comparison.resume_ids }, screening_id: screeningId },
      // As the pages rank them: the must-haves before the score.
      orderBy: [
        { musts_missing: 'asc' },
        { score: 'desc' },
        { created_at: 'asc' },
      ],
      include: WITH_GRID,
    });
    const gone = new Set((await this.missing(all)).map((m) => m.resumeId));
    const read = await Promise.all(
      all
        .filter((r) => !gone.has(r.id))
        .map(async (resume) => ({ resume, text: await this.textOf(resume) })),
    );
    // One that cannot be read after all is left out, like the missing ones.
    const compared = read.filter(
      (c): c is { resume: (typeof all)[number]; text: string } =>
        c.text !== null,
    );
    if (compared.length < MIN_COMPARED) {
      const left = new Set(compared.map((c) => c.resume.id));
      const names = all
        .filter((r) => !left.has(r.id))
        .map((r) => candidateName(r) ?? r.file_name);
      throw new ForbiddenException(
        `Il ne reste pas assez de CV à comparer. N’est plus disponible : ${names.join(', ')}.`,
      );
    }
    const resumes = compared.map((c) => c.resume);

    // Counted and saved under one lock (per screening): two tabs at once
    // both passed the count above.
    const { saved, before } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${screeningId}))`;
      const before = await this.askedAbout(comparison.resume_ids, tx);
      if (before >= limit) {
        throw new ForbiddenException(
          `Vous avez posé les ${limit} questions prévues pour l’un de ces CV dans vos comparaisons.`,
        );
      }
      const saved = await tx.cvComparisonMessage.create({
        data: {
          comparison_id: comparison.id,
          role: CvChatRole.USER,
          content: text,
        },
      });
      return { saved, before };
    });

    const history = comparison.messages
      .slice(-HISTORY_TURNS * 2)
      .map((m) =>
        m.role === CvChatRole.USER
          ? new HumanMessage(m.content)
          : new AIMessage(m.content),
      );
    const language = chatLanguage(
      text,
      comparison.messages
        .filter((m) => m.role === CvChatRole.USER)
        .map((m) => m.content),
      {
        title: comparison.screening.job_title,
        text: comparison.screening.job_text,
      },
    );
    return {
      language,
      comparisonId: comparison.id,
      questionId: saved.id,
      remaining: limit - before - 1,
      resumes,
      messages: [
        new SystemMessage(chatPrompt(SYSTEM_PROMPT, language)),
        new HumanMessage(
          contextText(
            {
              title: comparison.screening.job_title,
              text: comparison.screening.job_text,
              country: await this.chat.countryOf(
                comparison.screening.business_id,
              ),
            },
            compared,
          ),
        ),
        new AIMessage(READY[language]),
        ...history,
        new HumanMessage(text),
      ],
    };
  }

  answer(turn: CvCompareTurn, signal: AbortSignal): AsyncGenerator<string> {
    const comparisonId = turn.comparisonId;
    return this.chat.streamReply(turn.messages, comparisonId, signal, {
      language: turn.language,
      charts: chartTools(turn.resumes, turn.language, [
        'scores',
        'criteres',
        'experience',
      ]),
      save: async (content) => {
        await this.prisma.cvComparisonMessage.create({
          data: {
            comparison_id: comparisonId,
            role: CvChatRole.ASSISTANT,
            content,
          },
        });
      },
      // This turn's question, by its id.
      takeBack: async () => {
        await this.prisma.cvComparisonMessage.deleteMany({
          where: { id: turn.questionId, role: CvChatRole.USER },
        });
      },
    });
  }

  /**
   * The most questions asked about any one of these CVs, across all the
   * comparisons it is in: what the plan's questions limit.
   */
  private async askedAbout(
    resumeIds: string[],
    db: Pick<Prisma.TransactionClient, 'cvComparisonMessage'> = this.prisma,
  ): Promise<number> {
    const counts = await Promise.all(
      resumeIds.map((id) =>
        db.cvComparisonMessage.count({
          where: {
            role: CvChatRole.USER,
            comparison: { resume_ids: { has: id } },
          },
        }),
      ),
    );
    return Math.max(0, ...counts);
  }

  /** Those of these CVs that cannot be compared any more, and why. */
  private async missing(resumes: CvScreeningResume[]): Promise<
    {
      resumeId: string;
      name: string;
      reason: Exclude<CvAvailability, 'ready' | 'restorable'>;
    }[]
  > {
    const states = await this.restores.availability(resumes);
    return resumes.flatMap((r) => {
      const state = states.get(r.id) ?? 'expired';
      return usable(state)
        ? []
        : [
            {
              resumeId: r.id,
              name: candidateName(r) ?? r.file_name,
              reason: state,
            },
          ];
    });
  }

  /** A CV's text; null when it cannot be had (a scan nobody reads, a rebuild that failed). */
  private async textOf(resume: CvScreeningResume): Promise<string | null> {
    try {
      return await this.chat.cvTextOf(resume);
    } catch (err) {
      if (err instanceof HttpException) return null;
      throw err;
    }
  }

  private async business(profileId: string) {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    const e = await this.subscriptions.entitlements(businessId);
    return {
      businessId,
      limit: e.cvChatQuestions,
      trialLocked: e.trialLocked.includes('cvChat'),
    };
  }
}

/** The job, then each candidate: name, score, what the analysis found, and the CV. */
function contextText(
  job: { title: string; text: string; country: string | null },
  candidates: { resume: CvScreeningResume & OnGrid; text: string }[],
): string {
  const blocks = candidates.map(({ resume, text }, i) => {
    const name = candidateName(resume) ?? `Candidat ${i + 1}`;
    return [
      `### ${name}`,
      `Score : ${resume.score ?? '?'}/100`,
      criteriaLine(resume),
      resume.summary ? `Résumé : ${resume.summary}` : null,
      resume.strengths.length
        ? `Points forts : ${resume.strengths.join(' ; ')}`
        : null,
      resume.gaps.length
        ? `Points d’attention : ${resume.gaps.join(' ; ')}`
        : null,
      careerOf(resume),
      `CV :\n${text.slice(0, CV_CHARS_EACH)}`,
      answersBlock(readApplicationAnswers(resume.application_answers)),
    ]
      .filter(Boolean)
      .join('\n');
  });
  return `${job.country ? `Pays de l’organisation : ${job.country}\n\n` : ''}Offre : ${job.title}\n\n${job.text}\n\n---\nCandidats comparés (${candidates.length}) :\n\n${blocks.join('\n\n')}`;
}

function candidateName(resume: CvScreeningResume): string | null {
  const c = resume.candidate;
  return c &&
    typeof c === 'object' &&
    !Array.isArray(c) &&
    typeof c.name === 'string' &&
    c.name.trim()
    ? c.name.trim()
    : null;
}
