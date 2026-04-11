import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import { menuMessage } from '../messages/menu.messages';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';

export type RecommendedProfilesContext = {
  prisma: PrismaService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

function formatWorkerCard(
  index: number,
  w: {
    first_name: string;
    last_name: string;
    reliability_score: number | null;
    description: string | null;
    category?: { name: string } | null;
  },
): string {
  const name = `${w.first_name} ${w.last_name}`.trim();
  const score = w.reliability_score ?? 100;
  const domain = w.category?.name ?? 'Non spécifié';
  const desc = w.description
    ? `\n_${w.description.slice(0, 80)}${w.description.length > 80 ? '…' : ''}_`
    : '';
  return `${index}. *${name}*\n   ⭐ Score: ${score}/100 | 🏷 ${domain}${desc}`;
}

export async function runRecommendedProfilesFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: RecommendedProfilesContext,
): Promise<FlowResult> {
  const payload = state.payload || {};
  const workerIds = (payload.workerIds as string[]) ?? [];
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  const goToMenu = (): FlowResult => ({
    reply: [menuMessage(profile.profile_type)],
    clearState: true,
  });

  if (
    CMD_MENU.some((c) => normalized === c || normalized.startsWith(c + ' '))
  ) {
    return goToMenu();
  }

  if (workerIds.length === 0) {
    return {
      reply: [
        "*Aucun profil recommandé pour le moment. Tapez 'Menu' pour revenir.*",
      ],
      clearState: true,
    };
  }

  const pageWorkerIds = workerIds.slice(0, 5);
  const workers = await ctx.prisma.profile.findMany({
    where: { id: { in: pageWorkerIds } },
    select: {
      id: true,
      first_name: true,
      last_name: true,
      reliability_score: true,
      description: true,
      category: { select: { name: true } },
    },
  });

  // Preserve similarity order
  const workerMap = new Map(workers.map((w) => [w.id, w]));
  const orderedWorkers = pageWorkerIds
    .map((id) => workerMap.get(id))
    .filter(Boolean) as typeof workers;

  if (normalized === '7') return goToMenu();

  const lines = [
    '🎯 *TRAVAILLEURS RECOMMANDÉS*',
    '',
    ...orderedWorkers.map((w, i) => formatWorkerCard(i + 1, w)),
    '',
    '*Tapez le numéro pour voir le profil complet ou 7 pour le menu.*',
  ];

  const choice = /^[1-5]$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;
  if (choice >= 1 && choice <= orderedWorkers.length) {
    const worker = orderedWorkers[choice - 1];
    const completedCount = await ctx.prisma.application.count({
      where: {
        worker_id: worker.id,
        status: 'ACCEPTED',
        job_offer: { status: 'COMPLETED' },
      },
    });
    const domain = worker.category?.name ?? 'Non spécifié';
    const detail = [
      `👤 *${worker.first_name} ${worker.last_name}*`,
      `⭐ Score fiabilité: ${worker.reliability_score ?? 100}/100`,
      `🏷 Domaine: ${domain}`,
      `✅ Missions complétées: ${completedCount}`,
      worker.description ? `\n_${worker.description}_` : '',
      '',
      'Tapez *7* pour revenir au menu.',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      reply: [detail],
      nextState: {
        ...state,
        payload: { ...payload, workerIds },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  return {
    reply: [lines.join('\n')],
    nextState: state,
  };
}

export function getRecommendedProfilesInitialState(
  workerIds: string[],
): BotState {
  return {
    flowId: FLOW_IDS.RECOMMENDED_PROFILES,
    step: 0,
    payload: { workerIds },
    updatedAt: new Date().toISOString(),
  };
}
