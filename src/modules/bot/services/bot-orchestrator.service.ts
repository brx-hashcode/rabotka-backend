import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { AccountStatus, BillingStatus } from '@prisma/client';
import { JobOfferService } from '../../job-offer/job-offer.service';
import { ApplicationService } from '../../application/application.service';
import { BotStateService } from './bot-state.service';
import { BotRouterService } from '../router/bot-router.service';
import { BotCommandsService } from './bot-commands.service';
import { BotNotificationService } from './bot-notification.service';
import { BotInboxService } from './bot-inbox.service';
import { BotDraftService } from './bot-draft.service';
import { handleMenuCommand } from '../commands/menu.command';
import { handleHelpCommand } from '../commands/help.command';
import { SystemConfigService } from '../../system-config/system-config.service';
import {
  unknownCommandMessage,
  accountSuspendedBotMessage,
  hasPenaltiesBotMessage,
} from '../messages/menu.messages';
import type { BotProfile, BotState } from '../types/bot-state.types';
import type { FlowContext, FlowResult } from '../types/flow.types';
import { FLOW_IDS } from '../bot.constants';
import {
  runPublishJobFlow,
  getPublishJobInitialState,
  getPublishJobFirstMessage,
  getPublishJobDraftResumeMessage,
} from '../flows/publish-job.flow';
import {
  runListOffersFlow,
  getListOffersInitialState,
} from '../flows/list-offers.flow';
import { runApplyJobFlow } from '../flows/apply-job.flow';
import {
  runAcceptRefuseCandidateFlow,
  getAcceptRefuseInitialState,
} from '../flows/accept-refuse-candidate.flow';
import { runCancelApplicationFlow } from '../flows/cancel-application.flow';
import {
  runMyApplicationsFlow,
  getMyApplicationsInitialState,
} from '../flows/my-applications.flow';
import {
  runCandidaturesListFlow,
  getCandidaturesListInitialState,
} from '../flows/candidatures-list.flow';
import {
  runManageFilledJobFlow,
  getManageFilledJobInitialState,
} from '../flows/manage-filled-job.flow';
import {
  runProfileSubmenuFlow,
  getProfileSubmenuInitialState,
} from '../flows/profile-submenu.flow';
import {
  runPayPenaltiesFlow,
  getPayPenaltiesInitialState,
} from '../flows/pay-penalties.flow';
import { runResolvePenaltiesFlow } from '../flows/resolve-penalties.flow';
import {
  runVerifyWhatsappFlow,
  getVerifyWhatsappInitialState,
} from '../flows/verify-whatsapp.flow';
import { PaymentService } from '../../payments/payment.service';
import { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import { WalletService } from '../../wallet/wallet.service';
import {
  runUnlockContactFlow,
  getUnlockContactInitialState,
} from '../flows/unlock-contact.flow';
import {
  runRecommendedJobsFlow,
  getRecommendedJobsInitialState,
} from '../flows/recommended-jobs.flow';
import {
  runRecommendedProfilesFlow,
  getRecommendedProfilesInitialState,
} from '../flows/recommended-profiles.flow';
import { runRateAssignmentFlow } from '../flows/rate-assignment.flow';
import { MatchingService } from '../../matching/matching.service';
import { runRepublishExpiredJobFlow } from '../flows/republish-expired-job.flow';
import { InterestSignalService } from '../../interest-graph/interest-signal.service';
import { InterestRecommendationService } from '../../interest-graph/interest-recommendation.service';

const INACTIVE_MESSAGE = `Votre compte est créé mais pas encore activé. Cliquez sur le lien de confirmation que nous vous avons envoyé par WhatsApp pour l’activer.`;

const WHATSAPP_NOT_CONNECTED_MESSAGE = `⚠️ Votre numéro WhatsApp n’est pas encore vérifié. Veuillez d’abord vérifier votre numéro WhatsApp via le lien de vérification qui vous a été envoyé.`;

const NOT_FOUND_MESSAGE = `Ce numéro n'est pas encore enregistré. Inscrivez-vous sur notre site pour créer votre compte.`;

const ERROR_MESSAGE = `Une erreur est survenue. Veuillez réessayer ou tapez « Menu ».`;

function looksLikeFlowInput(input: string): boolean {
  const t = input.trim();
  return /^\d+$/.test(t) || (t.length > 0 && t.length <= 20 && !/\s/.test(t));
}

@Injectable()
export class BotOrchestratorService {
  private readonly logger = new Logger(BotOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botState: BotStateService,
    private readonly botInbox: BotInboxService,
    private readonly botDraft: BotDraftService,
    private readonly router: BotRouterService,
    private readonly commands: BotCommandsService,
    private readonly jobOfferService: JobOfferService,
    private readonly applicationService: ApplicationService,
    private readonly notificationService: BotNotificationService,
    private readonly systemConfig: SystemConfigService,
    private readonly paymentService: PaymentService,
    private readonly contactUnlockService: ContactUnlockService,
    private readonly walletService: WalletService,
    private readonly matchingService: MatchingService,
    private readonly interestSignalService: InterestSignalService,
    private readonly interestRecommendationService: InterestRecommendationService,
  ) {}

  async handle(
    profileId: string,
    _phone: string,
    text: string,
  ): Promise<string[]> {
    const profile = await this.loadProfile(profileId);
    if (!profile) {
      return [NOT_FOUND_MESSAGE];
    }

    const allowed: string[] = [
      AccountStatus.ACTIVE,
      AccountStatus.SUSPENDED,
      AccountStatus.PENDING_ACTIVATION,
    ];
    if (!allowed.includes(profile.status)) {
      return [INACTIVE_MESSAGE];
    }

    const botProfile = this.toBotProfile(profile);

    if (profile.status === AccountStatus.SUSPENDED) {
      const contact = await this.systemConfig.getContactInfo();
      return [accountSuspendedBotMessage(contact)];
    }

    if (!profile.whatsapp_connected) {
      return [WHATSAPP_NOT_CONNECTED_MESSAGE];
    }

    if (profile.status === AccountStatus.PENDING_ACTIVATION) {
      return this.handlePendingActivation(profileId, text, botProfile);
    }

    if (profile.billing_status !== BillingStatus.CLEAR) {
      const normalized = text.trim().toLowerCase();
      const state = await this.botState.get(profileId);
      const canContinueFlow =
        state?.flowId === FLOW_IDS.PAY_PENALTIES ||
        state?.flowId === FLOW_IDS.UNLOCK_CONTACT ||
        state?.flowId === FLOW_IDS.MY_APPLICATIONS;
      const canOpenPaymentRelatedCommand =
        normalized === 'payer' ||
        normalized === 'pay' ||
        normalized === 'contact' ||
        normalized === 'unlock' ||
        normalized === 'mes candidatures' ||
        normalized === 'mes applications' ||
        normalized === 'paiements en attente';
      if (canContinueFlow || canOpenPaymentRelatedCommand) {
        return this.routeMessage(profileId, text, profile, botProfile);
      }
      return [hasPenaltiesBotMessage()];
    }

    return this.routeMessage(profileId, text, profile, botProfile);
  }

  private async handlePendingActivation(
    profileId: string,
    text: string,
    botProfile: BotProfile,
  ): Promise<string[]> {
    const state = await this.botState.get(profileId);
    const isReturningToFlow = state?.flowId === FLOW_IDS.VERIFY_WHATSAPP;
    const flowState = isReturningToFlow
      ? state
      : getVerifyWhatsappInitialState();
    const flowInput = isReturningToFlow ? text : '';
    const result = await runVerifyWhatsappFlow(
      flowState,
      flowInput,
      botProfile,
      this.buildFlowContext(),
    );
    if (result.clearState) {
      await this.botState.clear(profileId);
    } else if (result.nextState) {
      await this.botState.set(profileId, result.nextState);
    }
    return result.reply;
  }

  private async routeMessage(
    profileId: string,
    text: string,
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    botProfile: BotProfile,
  ): Promise<string[]> {
    try {
      const state = await this.botState.get(profileId);
      const route = this.router.route(text, botProfile, state);

      if (route.type === 'flow') {
        return this.runFlow(
          route.flowId,
          route.state,
          text,
          botProfile,
          profileId,
        );
      }

      if (route.type === 'command') {
        return this.handleCommandRoute(route, profile, profileId, botProfile);
      }

      if (!state) {
        return [
          '⏱ *Session expirée.* Votre conversation précédente a expiré.',
          handleMenuCommand(botProfile),
        ];
      }

      return [unknownCommandMessage()];
    } catch (err) {
      this.logger.warn('Bot handling error', err);
      return [ERROR_MESSAGE];
    }
  }

  private toBotProfile(
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
  ): BotProfile {
    return {
      id: profile.id,
      first_name: profile.first_name,
      last_name: profile.last_name,
      phone: profile.phone,
      email: profile.email,
      profile_type: profile.profile_type as BotProfile['profile_type'],
      status: profile.status,
      reliability_score: profile.reliability_score,
    };
  }

  private async runFlow(
    flowId: string,
    state: BotState,
    input: string,
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    const result = await this.executeFlow(flowId, state, input, profile);
    if (!result) {
      this.logger.debug(`Flow ${flowId} not implemented`);
      return [unknownCommandMessage()];
    }

    if (result.clearState) {
      if (state.flowId === FLOW_IDS.PUBLISH_JOB) {
        await this.botDraft.clearDraft(profileId).catch(() => {});
      }
      await this.botState.clear(profileId);
      const nextInboxItem = await this.botInbox.peekAndShift(profileId);
      if (nextInboxItem?.type === 'new_application') {
        const nextState = getAcceptRefuseInitialState(
          nextInboxItem.applicationId,
        );
        await this.botState.set(profileId, nextState);
        const remaining = await this.botInbox.count(profileId);
        const inboxNotice =
          remaining > 0
            ? `\n\n📬 Il vous reste *${remaining}* candidature(s) en attente.`
            : '';
        return [
          ...result.reply,
          `\n📬 *Nouvelle candidature en attente* : ${nextInboxItem.workerName} pour « ${nextInboxItem.offerTitle} ».` +
            `\nRépondez par *1 – Accepter* ou *2 – Refuser*.` +
            inboxNotice,
        ];
      }
    } else if (result.nextState) {
      if (result.clearDraft) {
        await this.botDraft.clearDraft(profileId).catch(() => {});
      }
      await this.botState.set(profileId, result.nextState);
    }

    if (profile.profile_type === 'EMPLOYER') {
      const inboxCount = await this.botInbox.count(profileId);
      if (inboxCount > 0) {
        const last = result.reply.at(-1) ?? '';
        const lastIdx = result.reply.length - 1;
        result.reply[lastIdx] =
          last +
          `\n\n📬 *${inboxCount} candidature(s) en attente.* Tapez *candidatures* pour les traiter.`;
      }
    }

    return result.reply;
  }

  private buildFlowContext(): FlowContext {
    return {
      prisma: this.prisma,
      jobOfferService: this.jobOfferService,
      applicationService: this.applicationService,
      notificationService: this.notificationService,
      systemConfigService: this.systemConfig,
      paymentService: this.paymentService,
      commands: this.commands,
      contactUnlockService: this.contactUnlockService,
      walletService: this.walletService,
      interestSignalService: this.interestSignalService,
    };
  }

  private executeFlow(
    flowId: string,
    state: BotState,
    input: string,
    profile: BotProfile,
  ): Promise<FlowResult | null> {
    const ctx = this.buildFlowContext();
    const runners: Record<string, () => Promise<FlowResult>> = {
      [FLOW_IDS.PUBLISH_JOB]: () =>
        runPublishJobFlow(state, input, profile, ctx),
      [FLOW_IDS.LIST_OFFERS]: () =>
        runListOffersFlow(state, input, profile, ctx),
      [FLOW_IDS.APPLY_JOB]: () => runApplyJobFlow(state, input, profile, ctx),
      [FLOW_IDS.ACCEPT_REFUSE_CANDIDATE]: () =>
        runAcceptRefuseCandidateFlow(state, input, profile, ctx),
      [FLOW_IDS.CANCEL_APPLICATION]: () =>
        runCancelApplicationFlow(state, input, profile, ctx),
      [FLOW_IDS.MY_APPLICATIONS]: () =>
        runMyApplicationsFlow(state, input, profile, ctx),
      [FLOW_IDS.CANDIDATURES_LIST]: () =>
        runCandidaturesListFlow(state, input, profile, ctx),
      [FLOW_IDS.MANAGE_FILLED_JOB]: () =>
        runManageFilledJobFlow(state, input, profile, ctx),
      [FLOW_IDS.PROFILE_SUBMENU]: () =>
        runProfileSubmenuFlow(state, input, profile, ctx),
      [FLOW_IDS.PAY_PENALTIES]: () =>
        runPayPenaltiesFlow(state, input, profile, ctx),
      [FLOW_IDS.RESOLVE_PENALTIES]: () =>
        runResolvePenaltiesFlow(state, input, profile, ctx),
      [FLOW_IDS.VERIFY_WHATSAPP]: () =>
        runVerifyWhatsappFlow(state, input, profile, ctx),
      [FLOW_IDS.UNLOCK_CONTACT]: () =>
        runUnlockContactFlow(state, input, profile, {
          ...ctx,
          botNotification: this.notificationService,
        }),
      [FLOW_IDS.RECOMMENDED_JOBS]: () =>
        runRecommendedJobsFlow(state, input, profile, ctx),
      [FLOW_IDS.REPUBLISH_EXPIRED_JOB]: () =>
        runRepublishExpiredJobFlow(state, input, profile, {
          prisma: this.prisma,
          jobOfferService: this.jobOfferService,
        }),
      [FLOW_IDS.RECOMMENDED_PROFILES]: () =>
        runRecommendedProfilesFlow(state, input, profile, {
          prisma: this.prisma,
          systemConfig: this.systemConfig,
          contactUnlockService: this.contactUnlockService,
          walletService: this.walletService,
          paymentService: this.paymentService,
          botNotification: this.notificationService,
          employerProfileId: profile.id,
          interestSignalService: this.interestSignalService,
        }),
      [FLOW_IDS.RATE_ASSIGNMENT]: () =>
        runRateAssignmentFlow(state, input, profile, { prisma: this.prisma }),
      [FLOW_IDS.MY_OFFERS]: async () => {
        const currentPage = (state.payload?.page as number) ?? 0;
        const normalized = input.trim().toLowerCase();
        if (normalized === 'menu' || normalized === 'aide') {
          return { reply: [handleMenuCommand(profile)], clearState: true };
        }
        const PAGE_SIZE = 5;
        const { total } = await this.jobOfferService.findByEmployerId(
          profile.id,
          {
            page: 0,
            pageSize: 1,
          },
        );
        const nextPage = currentPage + 1;
        const nextPageStart = nextPage * PAGE_SIZE;
        const hasMore = nextPageStart < total;
        const nextPageNum = nextPageStart + 1;
        if (input.trim() === String(nextPageNum) && hasMore) {
          const message = await this.commands.myOffers(profile, nextPage);
          return {
            reply: [message],
            nextState: {
              flowId: FLOW_IDS.MY_OFFERS,
              step: 0,
              payload: { page: nextPage },
              updatedAt: new Date().toISOString(),
            },
          };
        }
        return { reply: [unknownCommandMessage()], nextState: state };
      },
    };
    const runner = runners[flowId];
    return runner ? runner() : Promise.resolve(null);
  }

  private async handleCommandRoute(
    route: { type: 'command'; commandId: string },
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    profileId: string,
    botProfile: BotProfile,
  ): Promise<string[]> {
    const commandHandlers: Record<string, () => Promise<string[]>> = {
      start_publish_job: () => this.handleStartPublishJobCommand(profileId),

      list_offers: () => this.handleListOffersCommand(profile, profileId),

      my_applications: () =>
        this.handleMyApplicationsCommand(profile, profileId),

      pending_payments: () =>
        this.handlePendingPaymentsCommand(botProfile, profileId),

      candidatures_received: () =>
        this.handleCandidaturesReceivedCommand(botProfile, profileId),

      filled_jobs: () => this.handleFilledJobsCommand(botProfile, profileId),

      my_offers: () => this.handleMyOffersCommand(botProfile, profileId, 0),

      profile: () => this.handleProfileCommand(profileId, botProfile),

      pay_penalties: () =>
        this.handlePayPenaltiesCommand(botProfile, profileId),

      unlock_contact: () =>
        this.handleUnlockContactCommand(botProfile, profileId),

      recommended_jobs: () =>
        this.handleRecommendedJobsCommand(botProfile, profileId),

      recommended_profiles: () =>
        this.handleRecommendedProfilesCommand(botProfile, profileId),
    };

    const handler = commandHandlers[route.commandId];
    if (handler) return handler();
    if (route.commandId === 'menu') {
      await this.botState.clear(profileId);
    }
    const reply = await this.runCommand(route.commandId, botProfile);
    return [reply];
  }

  private async handleProfileCommand(
    profileId: string,
    botProfile: BotProfile,
  ): Promise<string[]> {
    const message = await this.commands.profile(botProfile);
    const submenuState = getProfileSubmenuInitialState(botProfile.profile_type);
    await this.botState.set(profileId, submenuState);
    return [message];
  }

  private async handleStartPublishJobCommand(
    profileId: string,
  ): Promise<string[]> {
    const draft = await this.botDraft.getDraft(profileId);
    if (draft && draft.step > 1) {
      const resumeState: BotState = {
        flowId: FLOW_IDS.PUBLISH_JOB,
        step: 0,
        payload: { ...draft.payload, _draftStep: draft.step },
        updatedAt: new Date().toISOString(),
      };
      await this.botState.set(profileId, resumeState);
      return [getPublishJobDraftResumeMessage(draft.step, draft.payload)];
    }
    const initialState = getPublishJobInitialState();
    await this.botState.set(profileId, initialState);
    return [getPublishJobFirstMessage()];
  }

  private async handleListOffersCommand(
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    profileId: string,
  ): Promise<string[]> {
    const result = await this.commands.listOffers(profile);
    if (result.offerIds?.length) {
      const listState = getListOffersInitialState(
        result.offerIds,
        result.nextCursor,
      );
      await this.botState.set(profileId, listState);
    }
    return [result.message];
  }

  private async handleMyApplicationsCommand(
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    profileId: string,
  ): Promise<string[]> {
    const result = await this.commands.myApplications(profile);
    if (result.applicationIds?.length) {
      const myAppState = getMyApplicationsInitialState(result.applicationIds);
      await this.botState.set(profileId, myAppState);
    }
    return [result.message];
  }

  private async handlePendingPaymentsCommand(
    botProfile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    const result = await this.commands.pendingPayments(botProfile);
    const applicationIds: string[] | undefined = result.applicationIds;
    if (applicationIds != null && applicationIds.length > 0) {
      const state = getMyApplicationsInitialState(
        applicationIds,
        'pending_payments',
      );
      await this.botState.set(profileId, state);
    }
    return [result.message];
  }

  private async handleCandidaturesReceivedCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    const result = await this.commands.candidaturesReceived(profile);
    if (result.items?.length) {
      const listState = getCandidaturesListInitialState(result.items);
      await this.botState.set(profileId, listState);
    }
    return [result.message];
  }

  private async handleFilledJobsCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    const result = await this.commands.filledJobs(profile);
    if (result.items?.length) {
      const listState = getManageFilledJobInitialState(result.items);
      await this.botState.set(profileId, listState);
    }
    return [result.message];
  }

  private async handleMyOffersCommand(
    profile: BotProfile,
    profileId: string,
    page: number,
  ): Promise<string[]> {
    const message = await this.commands.myOffers(profile, page);
    await this.botState.set(profileId, {
      flowId: FLOW_IDS.MY_OFFERS,
      step: 0,
      payload: { page },
      updatedAt: new Date().toISOString(),
    });
    return [message];
  }

  private async handleUnlockContactCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    // Check if there's already an unlock state pre-loaded (e.g. by notification)
    const existingState = await this.botState.get(profileId);
    if (existingState?.flowId === FLOW_IDS.UNLOCK_CONTACT) {
      const result = await runUnlockContactFlow(existingState, '', profile, {
        contactUnlockService: this.contactUnlockService,
        walletService: this.walletService,
        paymentService: this.paymentService,
        botNotification: this.notificationService,
      });
      if (result.nextState) {
        await this.botState.set(profileId, result.nextState);
      }
      return result.reply;
    }

    // Look up the most recent pending attempt via service
    const attempt =
      await this.contactUnlockService.findPendingAttemptForProfile(profileId);

    if (!attempt) {
      return [
        `Aucune tentative de déverrouillage en cours.\n\nTapez *MENU* pour revenir.`,
      ];
    }

    const fees = await this.systemConfig.getContactUnlockFees();
    const isEmployer = attempt.employer_id === profileId;
    const otherPartyId = isEmployer ? attempt.worker_id : attempt.employer_id;
    const otherParty = await this.prisma.profile.findUnique({
      where: { id: otherPartyId },
      select: { first_name: true, last_name: true },
    });
    const otherName = otherParty
      ? `${otherParty.first_name} ${otherParty.last_name}`.trim()
      : 'votre contact';
    const amount = isEmployer ? fees.employerFeeFcfa : fees.workerFeeFcfa;

    const unlockState = getUnlockContactInitialState({
      attemptId: attempt.id,
      otherName,
      amount,
      expiryHours: fees.expiryHours,
    });
    await this.botState.set(profileId, unlockState);

    const result = await runUnlockContactFlow(unlockState, '', profile, {
      contactUnlockService: this.contactUnlockService,
      walletService: this.walletService,
      paymentService: this.paymentService,
      botNotification: this.notificationService,
    });
    if (result.nextState) {
      await this.botState.set(profileId, result.nextState);
    }
    return result.reply;
  }

  private async handlePayPenaltiesCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    const unpaid = await this.applicationService.getUnpaidPenalties(profile.id);
    if (unpaid.count === 0) {
      return [
        `✅ *Aucune pénalité impayée.* Votre compte est en règle.\n\nTapez *MENU* pour continuer.`,
      ];
    }
    const flowState = getPayPenaltiesInitialState(unpaid.count, unpaid.total);
    await this.botState.set(profileId, flowState);
    const result = await runPayPenaltiesFlow(flowState, '', profile, {
      applicationService: this.applicationService,
      walletService: this.walletService,
      paymentService: this.paymentService,
    });
    return result.reply;
  }

  private async handleRecommendedJobsCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    const offerResults = await this.interestRecommendationService.recommend(
      profile.id,
      10,
    );
    const offerIds: string[] = offerResults.map((r) => r.jobId);

    if (offerIds.length === 0) {
      return [
        [
          '*Offres recommandées*',
          '',
          "Aucune offre recommandée pour l'instant. Complétez votre profil pour de meilleures recommandations.",
          '',
          '*Tapez 1 pour voir toutes les offres disponibles ou Menu pour revenir.*',
        ].join('\n'),
      ];
    }

    const flowState = getRecommendedJobsInitialState(offerIds);
    const pageIds = offerIds.slice(0, 5);

    const [offers] = await Promise.all([
      this.prisma.jobOffer.findMany({
        where: {
          id: { in: pageIds },
          status: { in: ['ACTIVE', 'PARTIALLY_FILLED'] },
        },
        select: {
          id: true,
          title: true,
          amount: true,
          address: true,
          scheduled_at: true,
        },
      }),
      this.botState.set(profileId, flowState),
    ]);
    const offerMap = new Map(offers.map((o) => [o.id, o]));
    const orderedOffers = pageIds
      .map((id) => offerMap.get(id))
      .filter(Boolean) as typeof offers;

    if (orderedOffers.length === 0) {
      return [
        [
          '*Offres recommandées*',
          '',
          "Aucune offre recommandée pour l'instant. Complétez votre profil pour de meilleures recommandations.",
          '',
          '*Tapez 1 pour voir toutes les offres disponibles ou Menu pour revenir.*',
        ].join('\n'),
      ];
    }

    const lines = [
      '*OFFRES RECOMMANDÉES POUR VOUS*',
      '',
      ...orderedOffers.flatMap((o, i) => {
        const dateStr = o.scheduled_at.toLocaleDateString('fr-FR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        });
        const shortAddr =
          o.address.length > 40 ? o.address.slice(0, 40) + '…' : o.address;
        return [
          `${i + 1}- *${o.title}*`,
          `    • Montant : ${Number(o.amount).toLocaleString('fr-FR')} FCFA`,
          `    • Date : ${dateStr}`,
          `    • Adresse : ${shortAddr}`,
          '',
        ];
      }),
      'Tapez le numéro pour voir le détail ou *Menu* pour revenir au menu.',
    ];
    return [lines.join('\n')];
  }

  private async handleRecommendedProfilesCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    const latestOffer = await this.prisma.jobOffer.findFirst({
      where: { employer_id: profile.id, status: 'ACTIVE' },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });

    let workerResults: { id: string; score: number }[] = [];
    if (latestOffer) {
      workerResults = await this.matchingService.findMatchingWorkersForJob(
        latestOffer.id,
        10,
      );
    }
    if (workerResults.length === 0) {
      workerResults =
        await this.matchingService.findMatchingWorkersForEmployerProfile(
          profile.id,
          10,
        );
    }

    if (workerResults.length === 0) {
      return [
        [
          '*TRAVAILLEURS RECOMMANDÉS*',
          '',
          "Aucun travailleur recommandé pour l'instant. Publiez une offre pour obtenir des recommandations.",
          '',
          '*Tapez 1 pour publier une offre ou Menu pour revenir.*',
        ].join('\n'),
      ];
    }

    const workerIds = workerResults.map((r) => r.id);
    const workerScores: Record<string, number> = Object.fromEntries(
      workerResults.map((r) => [r.id, r.score]),
    );

    const flowState = getRecommendedProfilesInitialState(
      workerIds,
      workerScores,
      latestOffer?.id,
    );
    await this.botState.set(profileId, flowState);

    const { reliabilityScoreMin } = await this.systemConfig.getFees();
    const pageIds = workerIds.slice(0, 5);
    const workers = await this.prisma.profile.findMany({
      where: {
        id: { in: pageIds },
        verification_status: 'VERIFIED',
        reliability_score: { gte: reliabilityScoreMin },
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        reliability_score: true,
        description: true,
        category: { select: { name: true } },
      },
    });
    const workerMap = new Map(workers.map((w) => [w.id, w]));
    const ordered = pageIds
      .map((id) => workerMap.get(id))
      .filter(Boolean) as typeof workers;

    const lines = [
      '*TRAVAILLEURS RECOMMANDÉS*',
      '',
      ...ordered.flatMap((w, i) => {
        const name = `${w.first_name} ${w.last_name}`.trim();
        const domain = w.category?.name ?? 'Non spécifié';
        const aiScore = Math.round((workerScores[w.id] ?? 0) * 100);
        return [
          `${i + 1}- *${name}*`,
          `    • Fiabilité : ${w.reliability_score ?? 100}/100`,
          `    • Score IA : ${aiScore}%`,
          `    • Domaine : ${domain}`,
          '',
        ];
      }),
      `Tapez le numéro pour voir le profil complet ou *Menu* pour revenir au menu.`,
    ];
    return [lines.join('\n')];
  }

  private async loadProfile(profileId: string) {
    return this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        phone: true,
        email: true,
        profile_type: true,
        status: true,
        billing_status: true,
        reliability_score: true,
        whatsapp_connected: true,
      },
    });
  }

  private async runCommand(
    commandId: string,
    profile: BotProfile,
  ): Promise<string> {
    switch (commandId) {
      case 'menu':
        return handleMenuCommand(profile);
      case 'help': {
        const contact = await this.systemConfig.getContactInfo();
        return handleHelpCommand(commandId, contact);
      }
      case 'profile':
        return this.commands.profile(profile);
      case 'penalty_history':
        return this.commands.penaltyHistory(profile);
      default:
        return unknownCommandMessage();
    }
  }
}
