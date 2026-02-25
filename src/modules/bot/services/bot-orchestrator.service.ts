import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { AccountStatus } from '@prisma/client';
import { JobOfferService } from '../../job-offer/job-offer.service';
import { ApplicationService } from '../../application/application.service';
import { BotStateService } from './bot-state.service';
import { BotRouterService } from '../router/bot-router.service';
import { BotCommandsService } from './bot-commands.service';
import { BotNotificationService } from './bot-notification.service';
import { handleMenuCommand } from '../commands/menu.command';
import { handleHelpCommand } from '../commands/help.command';
import { unknownCommandMessage } from '../messages/menu.messages';
import type { BotProfile, BotState } from '../types/bot-state.types';
import { FLOW_IDS } from '../bot.constants';
import {
  runPublishJobFlow,
  getPublishJobInitialState,
  getPublishJobFirstMessage,
} from '../flows/publish-job.flow';
import {
  runListOffersFlow,
  getListOffersInitialState,
} from '../flows/list-offers.flow';
import { runApplyJobFlow } from '../flows/apply-job.flow';
import { runAcceptRefuseCandidateFlow } from '../flows/accept-refuse-candidate.flow';
import { runCancelApplicationFlow } from '../flows/cancel-application.flow';
import {
  runMyApplicationsFlow,
  getMyApplicationsInitialState,
} from '../flows/my-applications.flow';
import {
  runProfileSubmenuFlow,
  getProfileSubmenuInitialState,
} from '../flows/profile-submenu.flow';

const INACTIVE_MESSAGE =
  'Votre compte est créé mais pas encore activé. Cliquez sur le lien de confirmation que nous vous avons envoyé par WhatsApp pour l’activer.';

const NOT_FOUND_MESSAGE =
  "Ce numéro n'est pas encore enregistré. Inscrivez-vous sur notre site pour créer votre compte.";

const ERROR_MESSAGE =
  'Une erreur est survenue. Veuillez réessayer ou tapez « Menu ».';

@Injectable()
export class BotOrchestratorService {
  private readonly logger = new Logger(BotOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botState: BotStateService,
    private readonly router: BotRouterService,
    private readonly commands: BotCommandsService,
    private readonly jobOfferService: JobOfferService,
    private readonly applicationService: ApplicationService,
    private readonly notificationService: BotNotificationService,
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
    if (profile.status !== AccountStatus.ACTIVE) {
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
    if (result.clearState) await this.botState.clear(profileId);
    else if (result.nextState)
      await this.botState.set(profileId, result.nextState);
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
        }),
      [FLOW_IDS.LIST_OFFERS]: () =>
        runListOffersFlow(state, input, profile, {
          jobOfferService: deps.jobOfferService,
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
      [FLOW_IDS.PROFILE_SUBMENU]: () =>
        runProfileSubmenuFlow(state, input, profile, {
          commands: this.commands,
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
      profile: () => this.handleProfileCommand(profileId, botProfile),
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
      case 'help':
        return handleHelpCommand(commandId);
      case 'my_offers':
        return this.commands.myOffers(profile);
      case 'candidatures_received':
        return this.commands.candidaturesReceived(profile);
      case 'profile':
        return this.commands.profile(profile);
      case 'penalty_history':
        return this.commands.penaltyHistory(profile);
      default:
        return unknownCommandMessage();
    }
  }
}
