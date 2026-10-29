import {
  BadRequestException,
  ForbiddenException,
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
} from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import {
  ANSWER_STYLE,
  CHAT_RULES,
  CvChatService,
  HISTORY_TURNS,
  careerOf,
  reportCandidate,
  view,
} from './cv-chat.service';
import type { ChatReportInput } from './cv-chat-report';

export const MIN_COMPARED = 2;
export const MAX_COMPARED = 5;
/** Each CV's share of the prompt: five full CVs would drown the question. */
const CV_CHARS_EACH = 6_000;

const SYSTEM_PROMPT = [
  "Tu es l'assistant d'un recruteur, expert du recrutement au Congo-Brazzaville. Il compare PLUSIEURS candidats pour UN poste, d'après leurs CV.",
  'Appuie-toi uniquement sur les CV, l’offre et les analyses fournis. Nomme toujours les candidats par leur nom. Si une information manque dans un CV, dis-le plutôt que de la deviner.',
  'Commence par repérer les exigences essentielles de l’offre (métier, savoir-faire, expérience, lieu), puis juge chaque candidat sur ces exigences.',
  'Quand on te demande un classement ou qui retenir, tranche : une liste numérotée, du plus adapté au moins adapté, avec pour chacun ce qui le place à ce rang (ses atouts et ses manques précis, tirés du CV) et s’il mérite un entretien.',
  'Si AUCUN candidat ne remplit les exigences essentielles, dis-le dès la première phrase : un classement entre profils inadaptés ne doit pas laisser croire que le premier convient. Indique alors lequel, au besoin, serait le moins éloigné et pourquoi, et conseille de chercher d’autres profils.',
  'Termine par une recommandation concrète : qui inviter en entretien en premier, et ce qu’il faudra y vérifier.',
  '',
  ANSWER_STYLE,
  '',
  CHAT_RULES,
].join('\n');

export type CvCompareTurn = {
  comparisonId: string;
  messages: BaseMessage[];
  remaining: number;
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
    return {
      id: comparison.id,
      resumeIds: ids,
      messages: comparison.messages.map(view),
      limit,
      remaining: Math.max(0, limit - asked),
      available: resumes.every((r) => r.storage_key !== null),
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
    resumes.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
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
    const { businessId, limit } = await this.business(profileId);
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

    const asked = comparison.messages.filter(
      (m) => m.role === CvChatRole.USER,
    ).length;
    if (asked >= limit) {
      throw new ForbiddenException(
        limit === 0
          ? 'La conversation avec les CV n’est pas incluse dans votre formule.'
          : `Vous avez posé les ${limit} questions prévues pour cette comparaison.`,
      );
    }

    const resumes = await this.prisma.cvScreeningResume.findMany({
      where: { id: { in: comparison.resume_ids }, screening_id: screeningId },
      orderBy: [{ score: 'desc' }, { created_at: 'asc' }],
    });
    if (resumes.some((r) => !r.storage_key)) {
      throw new ForbiddenException(
        'Ces CV ont été supprimés à la fin de leur durée de conservation : la comparaison n’est plus possible.',
      );
    }
    const texts = await Promise.all(resumes.map((r) => this.chat.cvTextOf(r)));

    await this.prisma.cvComparisonMessage.create({
      data: {
        comparison_id: comparison.id,
        role: CvChatRole.USER,
        content: text,
      },
    });

    const history = comparison.messages
      .slice(-HISTORY_TURNS * 2)
      .map((m) =>
        m.role === CvChatRole.USER
          ? new HumanMessage(m.content)
          : new AIMessage(m.content),
      );
    return {
      comparisonId: comparison.id,
      remaining: limit - asked - 1,
      messages: [
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(
          contextText(
            {
              title: comparison.screening.job_title,
              text: comparison.screening.job_text,
            },
            resumes.map((r, i) => ({ resume: r, text: texts[i] })),
          ),
        ),
        new AIMessage('Bien noté. Quelle est votre question ?'),
        ...history,
        new HumanMessage(text),
      ],
    };
  }

  answer(turn: CvCompareTurn, signal: AbortSignal): AsyncGenerator<string> {
    const comparisonId = turn.comparisonId;
    return this.chat.streamReply(turn.messages, comparisonId, signal, {
      save: async (content) => {
        await this.prisma.cvComparisonMessage.create({
          data: {
            comparison_id: comparisonId,
            role: CvChatRole.ASSISTANT,
            content,
          },
        });
      },
      takeBack: async () => {
        const last = await this.prisma.cvComparisonMessage.findFirst({
          where: { comparison_id: comparisonId },
          orderBy: { created_at: 'desc' },
        });
        if (last?.role === CvChatRole.USER) {
          await this.prisma.cvComparisonMessage.delete({
            where: { id: last.id },
          });
        }
      },
    });
  }

  private async business(profileId: string) {
    const businessId = await this.subscriptions.businessOf(profileId);
    if (!businessId) {
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    }
    const e = await this.subscriptions.entitlements(businessId);
    return { businessId, limit: e.cvChatQuestions };
  }
}

/** The job, then each candidate: name, score, what the analysis found, and the CV. */
function contextText(
  job: { title: string; text: string },
  candidates: { resume: CvScreeningResume; text: string }[],
): string {
  const blocks = candidates.map(({ resume, text }, i) => {
    const name = candidateName(resume) ?? `Candidat ${i + 1}`;
    return [
      `### ${name}`,
      `Score : ${resume.score ?? '?'}/100`,
      resume.summary ? `Résumé : ${resume.summary}` : null,
      resume.strengths.length
        ? `Points forts : ${resume.strengths.join(' ; ')}`
        : null,
      resume.gaps.length
        ? `Points d’attention : ${resume.gaps.join(' ; ')}`
        : null,
      careerOf(resume),
      `CV :\n${text.slice(0, CV_CHARS_EACH)}`,
    ]
      .filter(Boolean)
      .join('\n');
  });
  return `Offre : ${job.title}\n\n${job.text}\n\n---\nCandidats comparés (${candidates.length}) :\n\n${blocks.join('\n\n')}`;
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
