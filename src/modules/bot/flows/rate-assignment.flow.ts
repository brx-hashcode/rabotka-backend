import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import type { PrismaService } from 'src/common/services/prisma/prisma.service';

export type RateAssignmentContext = {
  prisma: PrismaService;
};

type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

export async function runRateAssignmentFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: RateAssignmentContext,
): Promise<FlowResult> {
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
  ) {
    return {
      reply: ['Tapez *Menu* pour revenir au menu principal.'],
      clearState: true,
    };
  }

  const assignmentId = state.payload?.assignmentId as string | undefined;
  const rateeId = state.payload?.rateeId as string | undefined;

  if (!assignmentId || !rateeId) {
    return {
      reply: ["❌ Erreur d'évaluation. Tapez *Menu*."],
      clearState: true,
    };
  }

  const assignment = await ctx.prisma.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      status: true,
      worker_id: true,
      job_offer: { select: { employer_id: true } },
    },
  });

  if (!assignment) {
    return {
      reply: ['❌ Mission introuvable. Tapez *Menu*.'],
      clearState: true,
    };
  }

  const isWorker = assignment.worker_id === profile.id;
  const isEmployer = assignment.job_offer?.employer_id === profile.id;
  if (!isWorker && !isEmployer) {
    return {
      reply: [
        "❌ Vous n'êtes pas autorisé à évaluer cette mission. Tapez *Menu*.",
      ],
      clearState: true,
    };
  }

  if (assignment.status !== 'COMPLETED') {
    return {
      reply: ["❌ La mission n'est pas encore terminée. Tapez *Menu*."],
      clearState: true,
    };
  }

  const score = Number.parseInt(trimmed, 10);
  if (Number.isNaN(score) || score < 1 || score > 5) {
    return {
      reply: ['Répondez avec une note entre *1* et *5*.'],
      nextState: state,
    };
  }

  try {
    await ctx.prisma.$transaction(async (tx) => {
      // Upsert rating (idempotent — unique on rater_id + assignment_id)
      await tx.rating.upsert({
        where: {
          rater_id_assignment_id: {
            rater_id: profile.id,
            assignment_id: assignmentId,
          },
        },
        create: {
          rater_id: profile.id,
          ratee_id: rateeId,
          assignment_id: assignmentId,
          score,
        },
        update: { score },
      });

      // Recompute ratee's avg inside the same transaction to avoid read-then-write race
      const agg = await tx.rating.aggregate({
        where: { ratee_id: rateeId },
        _avg: { score: true },
        _count: { score: true },
      });
      await tx.profile.update({
        where: { id: rateeId },
        data: {
          rating_avg: agg._avg.score ?? null,
          rating_count: agg._count.score,
        },
      });
    });

    return {
      reply: [
        `✅ Merci pour votre évaluation (${score}/5) !\nVotre avis aide à améliorer la communauté Rabotka.`,
      ],
      clearState: true,
    };
  } catch {
    return {
      reply: ["❌ Impossible d'enregistrer votre note. Tapez *Menu*."],
      clearState: true,
    };
  }
}

export function getRateAssignmentInitialState(
  assignmentId: string,
  rateeId: string,
): BotState {
  return {
    flowId: FLOW_IDS.RATE_ASSIGNMENT,
    step: 1,
    payload: { assignmentId, rateeId },
    updatedAt: new Date().toISOString(),
  };
}
