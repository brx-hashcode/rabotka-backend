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
      reply: ["*Menu annulé. Tapez 'Menu' pour revenir.*"],
      clearState: true,
    };
  }

  const assignmentId = state.payload?.assignmentId as string | undefined;
  const rateeId = state.payload?.rateeId as string | undefined;

  if (!assignmentId || !rateeId) {
    return {
      reply: ["*Erreur d'évaluation. Tapez 'Menu'.*"],
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
    // Upsert rating (idempotent — unique on rater_id + assignment_id)
    await ctx.prisma.rating.upsert({
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

    // Recompute ratee's avg
    const agg = await ctx.prisma.rating.aggregate({
      where: { ratee_id: rateeId },
      _avg: { score: true },
      _count: { score: true },
    });
    await ctx.prisma.profile.update({
      where: { id: rateeId },
      data: {
        rating_avg: agg._avg.score ?? null,
        rating_count: agg._count.score,
      },
    });

    return {
      reply: [
        `✅ Merci pour votre évaluation (${score}/5) !\nVotre avis aide à améliorer la communauté Rabotka.`,
      ],
      clearState: true,
    };
  } catch {
    return {
      reply: ["*Impossible d'enregistrer votre note. Tapez 'Menu'.*"],
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
