import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { AccountStatus } from '@prisma/client';
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

const INACTIVE_MESSAGE = `Votre compte est créé mais pas encore activé. Cliquez sur le lien de confirmation que nous vous avons envoyé par WhatsApp pour l’activer.`;

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
  ) {}

  /**
   * Handle incoming message and return reply lines to send.
   * Caller (ConversationService) is responsible for sending via WhatsApp.
   */
  async handle(
    profileId: string,
    _phone: string,
    text: string,
  ): Promise<string[]> {
    const profile = await this.loadProfile(profileId);
    if (!profile) {
      return [NOT_FOUND_MESSAGE];
    }
    if (
      profile.status !== AccountStatus.ACTIVE &&
      profile.status !== AccountStatus.SUSPENDED &&
      profile.status !== AccountStatus.PENDING_ACTIVATION
    ) {
      return [INACTIVE_MESSAGE];
    }

    const botProfile: BotProfile = {
      id: profile.id,
      first_name: profile.first_name,
      last_name: profile.last_name,
      phone: profile.phone,
      email: profile.email,
      profile_type: profile.profile_type as BotProfile['profile_type'],
      status: profile.status,
      reliability_score: profile.reliability_score,
    };

    // Intercept suspended accounts — inform and direct to support
    if (profile.status === AccountStatus.SUSPENDED) {
      const contact = await this.systemConfig.getContactInfo();
      return [accountSuspendedBotMessage(contact)];
    }

    // Intercept PENDING_ACTIVATION accounts — force verify-whatsapp flow
    if (profile.status === AccountStatus.PENDING_ACTIVATION) {
      const state = await this.botState.get(profileId);
      const isReturningToFlow = state?.flowId === FLOW_IDS.VERIFY_WHATSAPP;
      const flowState = isReturningToFlow
        ? state
        : getVerifyWhatsappInitialState();
      // On first contact pass empty string so the flow shows the prompt;
      // on subsequent messages (already in the flow) pass the actual text.
      const flowInput = isReturningToFlow ? text : '';
      const result = await runVerifyWhatsappFlow(
        flowState,
        flowInput,
        botProfile,
        {
          prisma: this.prisma,
          paymentService: this.paymentService,
        },
      );
      if (result.clearState) {
        await this.botState.clear(profileId);
      } else if (result.nextState) {
        await this.botState.set(profileId, result.nextState);
      }
      return result.reply;
    }

    // Intercept accounts with unpaid penalties — block all functionalities
    if (profile.status === AccountStatus.ACTIVE) {
      const unpaid =
        await this.applicationService.getUnpaidPenalties(profileId);
      if (unpaid.count > 0) {
        return [hasPenaltiesBotMessage()];
      }
    }

    try {
      const state = await this.botState.get(profileId);
      const route = this.router.route(text, botProfile, state);

      if (route.type === 'flow') {
        const result = await this.runFlow(
          route.flowId,
          route.state,
          text,
          botProfile,
          profileId,
        );
        return result;
      }

      if (route.type === 'command') {
        return this.handleCommandRoute(route, profile, profileId, botProfile);
      }

      // No active state + no recognized command — show session expired if input
      // looks like the user was mid-flow before Redis TTL expired.
      if (!state && looksLikeFlowInput(text)) {
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
      // Save draft if employer exits publish-job mid-flow (step > 1)
      if (
        state.flowId === FLOW_IDS.PUBLISH_JOB &&
        state.step > 1 &&
        state.payload &&
        Object.keys(state.payload).length > 0
      ) {
        await this.botDraft
          .saveDraft(profileId, {
            step: state.step,
            payload: state.payload,
            savedAt: new Date().toISOString(),
          })
          .catch(() => {});
      }
      await this.botState.clear(profileId);
      // After clearing, check inbox for pending applications
      const nextInboxItem = await this.botInbox.shift(profileId);
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
      await this.botState.set(profileId, result.nextState);
    }

    // Append inbox badge if employer has pending items
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

  private executeFlow(
    flowId: string,
    state: BotState,
    input: string,
    profile: BotProfile,
  ): Promise<{
    reply: string[];
    clearState?: boolean;
    nextState?: BotState;
  } | null> {
    const deps = {
      jobOfferService: this.jobOfferService,
      applicationService: this.applicationService,
      notificationService: this.notificationService,
      systemConfigService: this.systemConfigService,
    };
    type FlowResult = {
      reply: string[];
      clearState?: boolean;
      nextState?: BotState;
    };
    const runners: Record<string, () => Promise<FlowResult>> = {
      [FLOW_IDS.PUBLISH_JOB]: () =>
        runPublishJobFlow(state, input, profile, {
          jobOfferService: deps.jobOfferService,
          paymentService: this.paymentService,
        }),
      [FLOW_IDS.LIST_OFFERS]: () =>
        runListOffersFlow(state, input, profile, {
          jobOfferService: deps.jobOfferService,
          systemConfigService: deps.systemConfigService,
        }),
      [FLOW_IDS.APPLY_JOB]: () => runApplyJobFlow(state, input, profile, deps),
      [FLOW_IDS.ACCEPT_REFUSE_CANDIDATE]: () =>
        runAcceptRefuseCandidateFlow(state, input, profile, {
          applicationService: deps.applicationService,
          notificationService: deps.notificationService,
        }),
      [FLOW_IDS.CANCEL_APPLICATION]: () =>
        runCancelApplicationFlow(state, input, profile, {
          applicationService: deps.applicationService,
          notificationService: deps.notificationService,
        }),
      [FLOW_IDS.MY_APPLICATIONS]: () =>
        runMyApplicationsFlow(state, input, profile, {
          applicationService: deps.applicationService,
          notificationService: deps.notificationService,
        }),
      [FLOW_IDS.CANDIDATURES_LIST]: () =>
        runCandidaturesListFlow(state, input, profile, {
          applicationService: deps.applicationService,
          notificationService: deps.notificationService,
        }),
      [FLOW_IDS.MANAGE_FILLED_JOB]: () =>
        runManageFilledJobFlow(state, input, profile, {
          applicationService: deps.applicationService,
          notificationService: deps.notificationService,
        }),
      [FLOW_IDS.PROFILE_SUBMENU]: () =>
        runProfileSubmenuFlow(state, input, profile, {
          commands: this.commands,
        }),
      [FLOW_IDS.PAY_PENALTIES]: () =>
        runPayPenaltiesFlow(state, input, profile, {
          applicationService: deps.applicationService,
        }),
      [FLOW_IDS.RESOLVE_PENALTIES]: () =>
        runResolvePenaltiesFlow(state, input, profile, {
          prisma: this.prisma,
          paymentService: this.paymentService,
        }),
      [FLOW_IDS.VERIFY_WHATSAPP]: () =>
        runVerifyWhatsappFlow(state, input, profile, {
          prisma: this.prisma,
          paymentService: this.paymentService,
        }),
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

      candidatures_received: () =>
        this.handleCandidaturesReceivedCommand(botProfile, profileId),

      filled_jobs: () => this.handleFilledJobsCommand(botProfile, profileId),

      profile: () => this.handleProfileCommand(profileId, botProfile),

      pay_penalties: () =>
        this.handlePayPenaltiesCommand(botProfile, profileId),
    };

    const handler = commandHandlers[route.commandId];
    if (handler) return handler();
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
      // Offer to resume the saved draft — step 0 = draft-resume decision
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
    });
    return result.reply;
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
        reliability_score: true,
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
      case 'my_offers':
        return this.commands.myOffers(profile);
      case 'profile':
        return this.commands.profile(profile);
      case 'penalty_history':
        return this.commands.penaltyHistory(profile);
      default:
        return unknownCommandMessage();
    }
  }
}
