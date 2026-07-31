import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS } from '../bot.constants';
import type { ApplicationService } from '../../application/application.service';
import type { BotNotificationService } from '../services/bot-notification.service';
import type { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import type { WalletService } from '../../wallet/wallet.service';
import type { SystemConfigService } from '../../system-config/system-config.service';
import type { PrismaService } from '../../../common/services/prisma/prisma.service';
import { formatContactUnlockPrompt } from '../messages/contact-unlock.messages';

export type AcceptRefuseContext = {
  prisma: PrismaService;
  applicationService: ApplicationService;
  notificationService: BotNotificationService;
  contactUnlockService: ContactUnlockService;
  walletService: WalletService;
  systemConfigService: SystemConfigService;
};

export type FlowResult = {
  reply: string[];
  nextState?: BotState;
  clearState?: boolean;
};

type StepArgs = {
  state: BotState;
  applicationId: string;
  trimmed: string;
  normalized: string;
  profile: BotProfile;
  ctx: AcceptRefuseContext;
};

async function handleAcceptRefuseStep1(args: StepArgs): Promise<FlowResult> {
  const { state, applicationId, normalized, profile, ctx } = args;
  if (!args.trimmed) {
    return {
      reply: [
        [
          '*Actions disponibles pour cette candidature :*',
          '',
          '1- Accepter le candidat',
          '2- Refuser',
          '',
          '*Tapez le numéro correspondant.*',
        ].join('\n'),
      ],
      nextState: state,
    };
  }
  if (normalized === '1' || normalized === 'accepter') {
    try {
      // accept() notifies the worker itself now, so both channels behave the
      // same; calling it here as well would send twice.
      await ctx.applicationService.accept(applicationId, profile.id);

      const attempt =
        await ctx.contactUnlockService.getByApplicationId(applicationId);
      if (attempt) {
        const fees = await ctx.systemConfigService.getContactUnlockFees();
        const workerData = await ctx.prisma.profile
          .findUnique({
            where: { id: attempt.worker_id },
            select: { first_name: true, last_name: true },
          })
          .catch(() => null);
        const workerName = workerData
          ? `${workerData.first_name} ${workerData.last_name}`.trim()
          : 'le travailleur';

        const jobOffer = await ctx.prisma.jobOffer
          .findUnique({
            where: { id: attempt.job_offer_id },
            select: { quantity: true, employer_unlock_paid: true },
          })
          .catch(() => null);

        const isMultiPerson = (jobOffer?.quantity ?? 1) > 1;
        const employerAlreadyPaid =
          isMultiPerson && jobOffer?.employer_unlock_paid;

        if (employerAlreadyPaid) {
          return {
            reply: [
              [
                '*Candidature acceptée !*',
                '',
                'Le travailleur a été notifié.',
                '',
                `✅ Votre paiement couvre déjà tous les candidats de ce poste.`,
                `Le contact avec *${workerName}* sera débloqué dès qu'il confirme de son côté.`,
                '',
                'Tapez *Menu* pour revenir.',
              ].join('\n'),
            ],
            clearState: true,
          };
        }

        const balance = await ctx.walletService.getProfileWalletBalance(
          profile.id,
        );

        const unlockPrompt = formatContactUnlockPrompt({
          name: workerName,
          amount: fees.employerFeeFcfa,
          balance,
          profileType: 'EMPLOYER',
          isJobLevel: isMultiPerson,
        });

        return {
          reply: [
            [
              '*Candidature acceptée !*',
              '',
              'Le travailleur a été notifié.',
              '',
              unlockPrompt,
            ].join('\n'),
          ],
          nextState: {
            flowId: FLOW_IDS.UNLOCK_CONTACT,
            step: 1,
            payload: {
              attemptId: attempt.id,
              otherName: workerName,
              amount: fees.employerFeeFcfa,
              expiresAt: attempt.expires_at.toISOString(),
            },
            updatedAt: new Date().toISOString(),
          },
        };
      }

      return {
        reply: [
          [
            '*Candidature acceptée !*',
            '',
            'Le travailleur a été notifié.',
            '',
            'Tapez *Menu* pour revenir.',
          ].join('\n'),
        ],
        clearState: true,
      };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "*IMPOSSIBLE D'ACCEPTER.*";
      return { reply: [`❌ ${message}`], nextState: state };
    }
  }
  if (normalized === '2' || normalized === 'refuser') {
    return {
      reply: [
        [
          'Raison du refus ? (optionnel).',
          "Tapez la raison ou 'Aucune' pour refuser sans raison.",
        ].join('\n'),
      ],
      nextState: {
        ...state,
        step: 2,
        payload: { ...state.payload },
        updatedAt: new Date().toISOString(),
      },
    };
  }
  return {
    reply: ['Répondez par 1 (Accepter) ou 2 (Refuser).'],
    nextState: state,
  };
}

function handleAcceptRefuseStep2(args: StepArgs): FlowResult {
  const { state, normalized, trimmed } = args;
  const reason =
    normalized === 'aucune' || normalized === '0' || normalized === 'non'
      ? null
      : trimmed;

  return {
    reply: [
      [
        '*Confirmer le refus ?*',
        '',
        reason ? `Raison : ${reason}` : 'Aucune raison fournie.',
        '',
        '1- Oui, refuser le candidat',
        '2- Annuler (garder la candidature en attente)',
      ].join('\n'),
    ],
    nextState: {
      ...state,
      step: 3,
      payload: { ...state.payload, refusalReason: reason ?? '' },
      updatedAt: new Date().toISOString(),
    },
  };
}

async function handleAcceptRefuseStep3(args: StepArgs): Promise<FlowResult> {
  const { state, applicationId, normalized, profile, ctx } = args;

  if (normalized === '2' || normalized === 'annuler') {
    return {
      reply: [
        '*Refus annulé.* La candidature reste en attente.\n\nTapez *Menu* pour revenir.',
      ],
      clearState: true,
    };
  }

  if (normalized !== '1' && normalized !== 'oui') {
    return {
      reply: ['*Répondez par 1 (confirmer le refus) ou 2 (annuler).*'],
      nextState: state,
    };
  }

  const reason =
    typeof state.payload.refusalReason === 'string' &&
    state.payload.refusalReason.length > 0
      ? state.payload.refusalReason
      : undefined;

  try {
    await ctx.applicationService.reject(applicationId, profile.id, reason);
    await ctx.notificationService.sendApplicationRejectedToWorker(
      applicationId,
    );
    return {
      reply: [
        [
          '*Candidature refusée.*',
          '',
          "Le candidat a été notifié. Votre offre reste ouverte pour d'autres candidatures.",
          '',
          'Tapez *Menu* pour revenir.',
        ].join('\n'),
      ],
      clearState: true,
    };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : '*IMPOSSIBLE DE REFUSER.*';
    return { reply: [`❌ ${message}`], nextState: state };
  }
}

export async function runAcceptRefuseCandidateFlow(
  state: BotState,
  input: string,
  profile: BotProfile,
  ctx: AcceptRefuseContext,
): Promise<FlowResult> {
  const payload = state.payload;
  const applicationId =
    typeof payload.applicationId === 'string'
      ? payload.applicationId
      : undefined;
  const trimmed = input.trim();
  const normalized = trimmed.toLowerCase();

  if (!applicationId) {
    return {
      reply: ['❌ Candidature non trouvée. Tapez *Menu*.'],
      clearState: true,
    };
  }

  if (profile.profile_type !== 'EMPLOYER') {
    return {
      reply: [
        '❌ Seuls les employeurs peuvent gérer les candidatures. Tapez *Menu*.',
      ],
      clearState: true,
    };
  }

  const args: StepArgs = {
    state,
    applicationId,
    trimmed,
    normalized,
    profile,
    ctx,
  };

  if (state.step === 1) return handleAcceptRefuseStep1(args);
  if (state.step === 2) return handleAcceptRefuseStep2(args);
  if (state.step === 3) return handleAcceptRefuseStep3(args);

  return {
    reply: ['❌ Erreur. Tapez *Menu* pour revenir.'],
    clearState: true,
  };
}

export function getAcceptRefuseInitialState(applicationId: string): BotState {
  return {
    flowId: FLOW_IDS.ACCEPT_REFUSE_CANDIDATE,
    step: 1,
    payload: { applicationId },
    updatedAt: new Date().toISOString(),
  };
}
