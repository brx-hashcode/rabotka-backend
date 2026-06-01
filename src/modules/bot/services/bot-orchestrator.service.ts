import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { AccountStatus, BillingStatus } from '@prisma/client';
import { translateJobOfferStatus } from '../utils/status.utils';
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
  menuMessage,
  penaltiesListBotMessage,
} from '../messages/menu.messages';
import type { BotProfile, BotState } from '../types/bot-state.types';
import type { FlowContext, FlowResult } from '../types/flow.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
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
  formatRecommendedList,
  jobOfferToOfferListItem,
} from '../messages/offers.messages';
import {
  runRecommendedProfilesFlow,
  getRecommendedProfilesInitialState,
} from '../flows/recommended-profiles.flow';
import { runRateAssignmentFlow } from '../flows/rate-assignment.flow';
import {
  runSearchByRefFlow,
  getSearchByRefInitialState,
  getSearchByRefPromptMessage,
} from '../flows/search-by-ref.flow';
import { MatchingService } from '../../matching/matching.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import { runRepublishExpiredJobFlow } from '../flows/republish-expired-job.flow';
import { runPostCancellationActionsFlow } from '../flows/post-cancellation-actions.flow';
import { runJobStatusCheckFlow } from '../flows/job-status-check.flow';
import { InterestSignalService } from '../../interest-graph/interest-signal.service';
import { InterestRecommendationService } from '../../interest-graph/interest-recommendation.service';
import { InvoiceService } from '../../invoice/invoice.service';

const INACTIVE_MESSAGE = `Votre compte est créé mais pas encore activé. Cliquez sur le lien de confirmation que nous vous avons envoyé par WhatsApp pour l'activer.`;

const KYC_APPROVED_PROMPT_MESSAGE = `✅ Votre vérification KYC a été validée !\n\nTapez *Menu* pour accéder à la plateforme et commencer.`;

const WHATSAPP_VERIFY_CODE_TTL_MINUTES = 15;

// Pseudo-flow id used while we're waiting for the user to pick which
// penalty (or all) to pay. Once they pick, we transition to the real
// FLOW_IDS.PAY_PENALTIES flow with the selected total.
const PENALTY_GATE_FLOW_ID = 'penalty_gate';

function buildVerifyPromptMessage(code: string): string {
  return [
    '🔐 *WhatsApp non vérifié*',
    '',
    "Votre compte est actif mais votre numéro WhatsApp n'a pas encore été vérifié.",
    '',
    `Tapez ce code *${code}* pour démarrer la vérification.`,
  ].join('\n');
}

function buildVerifySuccessMessage(): string {
  return [
    '✅ *WhatsApp vérifié avec succès !*',
    '',
    'Votre numéro est maintenant lié à votre compte.',
    '',
    'Tapez *Menu* pour commencer.',
  ].join('\n');
}

function buildVerifyInvalidMessage(code: string): string {
  return [
    '❌ Code incorrect ou expiré.',
    '',
    `Tapez ce code *${code}* pour vérifier votre numéro WhatsApp.`,
  ].join('\n');
}

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
    @Inject(forwardRef(() => PaymentService))
    private readonly paymentService: PaymentService,
    private readonly contactUnlockService: ContactUnlockService,
    private readonly walletService: WalletService,
    private readonly matchingService: MatchingService,
    private readonly interestSignalService: InterestSignalService,
    private readonly interestRecommendationService: InterestRecommendationService,
    private readonly invoiceService: InvoiceService,
    private readonly queueService: QueueService,
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
      return [
        accountSuspendedBotMessage({
          email: contact.email ?? '',
          phone: contact.phone ?? '',
          address: contact.address ?? '',
        }),
      ];
    }

    const normalizedInput = text.trim().toLowerCase();

    if (!profile.whatsapp_connected) {
      // ACTIVE but WhatsApp not yet verified — issue a 4-digit code inline,
      // and when the user echoes it back, activate immediately.
      // (A genuinely SUSPENDED account is already short-circuited above.)
      if (profile.status === AccountStatus.ACTIVE) {
        return this.handleInlineWhatsappVerification(profile, text);
      }

      // KYC approved (PENDING_ACTIVATION) + user types Menu → activate account
      if (
        CMD_MENU.some(
          (c) => normalizedInput === c || normalizedInput.startsWith(c + ' '),
        )
      ) {
        await this.prisma.profile.update({
          where: { id: profileId },
          data: {
            whatsapp_connected: true,
            status: AccountStatus.ACTIVE,
            whatsapp_activation_bonus_granted: true,
          },
        });
        if (!profile.whatsapp_activation_bonus_granted) {
          await this.walletService
            .grantWelcomeCredit(profileId, profile.profile_type)
            .catch(() => 0);
        }
        return [menuMessage(profile.profile_type)];
      }

      // PENDING_ACTIVATION + any other input → remind to type Menu
      return [KYC_APPROVED_PROMPT_MESSAGE];
    }

    if (profile.billing_status !== BillingStatus.CLEAR) {
      return this.handleBlockedByPenalties(
        profileId,
        text,
        profile,
        botProfile,
      );
    }

    return this.routeMessage(profileId, text, profile, botProfile);
  }

  /**
   * Inline WhatsApp verification for ACTIVE profiles whose number isn't
   * yet linked. We persist a 4-digit code in `verification_tokens` and
   * embed it directly in the prompt — the user only needs to type the
   * code back. On success: flip whatsapp_connected, grant welcome
   * credit (once), and send the congrats message.
   */
  private async handleInlineWhatsappVerification(
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    text: string,
  ): Promise<string[]> {
    const trimmed = text.trim();
    const now = new Date();

    // 1) If the user typed a 4-digit code, try to match it.
    if (/^\d{4}$/.test(trimmed)) {
      const match = await this.prisma.verificationToken.findFirst({
        where: {
          profile_id: profile.id,
          token: trimmed,
          used_at: null,
          expires_at: { gt: now },
        },
      });

      if (match) {
        await this.prisma.$transaction([
          this.prisma.verificationToken.update({
            where: { id: match.id },
            data: { used_at: now },
          }),
          this.prisma.profile.update({
            where: { id: profile.id },
            data: {
              whatsapp_connected: true,
              whatsapp_activation_bonus_granted: true,
            },
          }),
        ]);

        if (!profile.whatsapp_activation_bonus_granted) {
          await this.walletService
            .grantWelcomeCredit(profile.id, profile.profile_type)
            .catch(() => 0);
        }

        return [buildVerifySuccessMessage()];
      }

      // Bad/expired code — issue a fresh one so the user can try again.
      const newCode = await this.issueWhatsappVerificationCode(profile.id);
      return [buildVerifyInvalidMessage(newCode)];
    }

    // 2) Any non-code input → reuse the latest active code or issue a new one.
    const existing = await this.prisma.verificationToken.findFirst({
      where: {
        profile_id: profile.id,
        used_at: null,
        expires_at: { gt: now },
      },
      orderBy: { created_at: 'desc' },
    });
    const code =
      existing?.token ?? (await this.issueWhatsappVerificationCode(profile.id));
    return [buildVerifyPromptMessage(code)];
  }

  private async issueWhatsappVerificationCode(
    profileId: string,
  ): Promise<string> {
    // 4-digit zero-padded code. Collisions on `token` are possible since the
    // column is globally unique; retry a couple of times before giving up.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
      try {
        await this.prisma.verificationToken.create({
          data: {
            profile_id: profileId,
            token: code,
            expires_at: new Date(
              Date.now() + WHATSAPP_VERIFY_CODE_TTL_MINUTES * 60_000,
            ),
          },
        });
        return code;
      } catch {
        // Unique-constraint collision — try a different code.
      }
    }
    throw new Error('Could not issue WhatsApp verification code after retries');
  }

  /**
   * Penalty gate for profiles with billing_status != CLEAR.
   *
   *   Step A (no state)               → "You have penalties. Type *1* to list."
   *   Step A + user types "1"         → list penalties, ask which to pay.
   *   Step A.list + user picks index  → start PAY_PENALTIES flow for that one.
   *   Step A.list + user picks "0"    → start PAY_PENALTIES flow for the lot.
   *   In PAY_PENALTIES / UNLOCK / MY_APPLICATIONS → let the flow continue.
   */
  private async handleBlockedByPenalties(
    profileId: string,
    text: string,
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    botProfile: BotProfile,
  ): Promise<string[]> {
    const normalized = text.trim().toLowerCase();
    const state = await this.botState.get(profileId);

    // Already inside a payment-related flow — let it run.
    const canContinueFlow =
      state?.flowId === FLOW_IDS.PAY_PENALTIES ||
      state?.flowId === FLOW_IDS.UNLOCK_CONTACT ||
      state?.flowId === FLOW_IDS.MY_APPLICATIONS;
    if (canContinueFlow) {
      return this.routeMessage(profileId, text, profile, botProfile);
    }

    // Currently showing the penalty list and waiting for the user to pick one
    if (state?.flowId === PENALTY_GATE_FLOW_ID) {
      return this.handlePenaltyListSelection(
        profileId,
        text,
        profile,
        botProfile,
        state,
      );
    }

    // User typed "1" → list penalties
    if (normalized === '1') {
      const penalties = await this.loadUnpaidPenalties(profileId);
      if (penalties.length === 0) {
        // Race: billing_status not yet refreshed; just go to menu.
        return [menuMessage(profile.profile_type)];
      }
      await this.botState.set(profileId, {
        flowId: PENALTY_GATE_FLOW_ID,
        step: 1,
        payload: {
          penaltyIds: penalties.map((p) => p.id),
          amounts: penalties.map((p) => p.amount),
        },
        updatedAt: new Date().toISOString(),
      });
      return [
        penaltiesListBotMessage(
          penalties.map((p) => ({
            amount: p.amount,
            reason: p.reason ?? 'Pénalité',
            created_at: p.created_at,
            jobTitle: p.jobTitle,
          })),
        ),
      ];
    }

    return [hasPenaltiesBotMessage()];
  }

  private async handlePenaltyListSelection(
    profileId: string,
    text: string,
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    botProfile: BotProfile,
    state: BotState,
  ): Promise<string[]> {
    const trimmed = text.trim();
    const ids = (state.payload?.penaltyIds as string[]) ?? [];
    const amounts = (state.payload?.amounts as number[]) ?? [];

    if (!/^\d+$/.test(trimmed)) {
      return [
        "Tapez le *numéro* d'une pénalité ou *0* pour toutes les régler.",
      ];
    }
    const choice = Number.parseInt(trimmed, 10);

    let selectedAmount: number;
    let selectedCount: number;
    if (choice === 0) {
      selectedCount = ids.length;
      selectedAmount = amounts.reduce((s, a) => s + a, 0);
    } else if (choice >= 1 && choice <= ids.length) {
      selectedCount = 1;
      selectedAmount = amounts[choice - 1];
    } else {
      return [
        `Numéro invalide. Choisissez entre *1* et *${ids.length}*, ou *0*.`,
      ];
    }

    // Hand off to the existing PAY_PENALTIES flow at its main prompt
    // (wallet vs mobile money). It uses penaltyCount + totalAmount.
    const payState: BotState = {
      flowId: FLOW_IDS.PAY_PENALTIES,
      step: 1,
      payload: {
        penaltyCount: selectedCount,
        totalAmount: selectedAmount,
      },
      updatedAt: new Date().toISOString(),
    };
    await this.botState.set(profileId, payState);
    // Re-enter the flow with an empty input so it shows its main prompt.
    return this.routeMessage(profileId, '', profile, botProfile);
  }

  private async loadUnpaidPenalties(profileId: string): Promise<
    Array<{
      id: string;
      amount: number;
      reason: string | null;
      created_at: Date;
      jobTitle: string | null;
    }>
  > {
    const rows = await this.prisma.penalty.findMany({
      where: { profile_id: profileId, paid_at: null },
      select: {
        id: true,
        amount: true,
        reason: true,
        created_at: true,
        application: {
          select: { job_offer: { select: { title: true } } },
        },
      },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      reason: r.reason,
      created_at: r.created_at,
      jobTitle: r.application?.job_offer?.title ?? null,
    }));
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
        await this.botDraft
          .clearDraft(profileId)
          .catch((err: unknown) =>
            this.logger.warn(
              `clearDraft failed for profile ${profileId}`,
              err instanceof Error ? err.message : String(err),
            ),
          );
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
            ? `\n\nIl vous reste *${remaining}* candidature(s) en attente.`
            : '';
        return [
          ...result.reply,
          `\n*Nouvelle candidature en attente* : ${nextInboxItem.workerName} pour « ${nextInboxItem.offerTitle} ».` +
            `\nRépondez par *1 – Accepter* ou *2 – Refuser*.` +
            inboxNotice,
        ];
      }
    } else if (result.nextState) {
      if (result.clearDraft) {
        await this.botDraft
          .clearDraft(profileId)
          .catch((err: unknown) =>
            this.logger.warn(
              `clearDraft failed for profile ${profileId}`,
              err instanceof Error ? err.message : String(err),
            ),
          );
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
          `\n\n*${inboxCount} candidature(s) en attente.* Tapez *3* (Candidatures reçues) pour les traiter.`;
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
      invoiceService: this.invoiceService,
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
      [FLOW_IDS.CANCEL_APPLICATION]: async () => {
        const { cancellationThresholdHours } =
          await this.systemConfig.getFees();
        return runCancelApplicationFlow(state, input, profile, {
          ...ctx,
          cancellationThresholdHours,
        });
      },
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
        }),
      [FLOW_IDS.JOB_STATUS_CHECK]: () =>
        runJobStatusCheckFlow(state, input, profile, {
          applicationService: this.applicationService,
          notificationService: this.notificationService,
          queueService: this.queueService,
          employerId: profile.id,
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
          invoiceService: this.invoiceService,
        }),
      [FLOW_IDS.RATE_ASSIGNMENT]: () =>
        runRateAssignmentFlow(state, input, profile, { prisma: this.prisma }),
      [FLOW_IDS.SEARCH_BY_REF]: () =>
        runSearchByRefFlow(state, input, profile, ctx),
      [FLOW_IDS.MY_OFFERS]: async () => {
        const currentPage = (state.payload?.page as number) ?? 0;
        const offerIds = (state.payload?.offerIds as string[]) ?? [];
        const trimmed = input.trim();
        const normalized = trimmed.toLowerCase();
        if (CMD_MENU.some((c) => normalized === c || normalized === 'm')) {
          return { reply: [handleMenuCommand(profile)], clearState: true };
        }
        const PAGE_SIZE = 5;
        const { total } = await this.jobOfferService.findByEmployerId(
          profile.id,
          { page: 0, pageSize: 1 },
        );
        const totalPages = Math.ceil(total / PAGE_SIZE);
        if (normalized === 's' && currentPage < totalPages - 1) {
          const nextPage = currentPage + 1;
          const { message, offerIds: newOfferIds } =
            await this.commands.myOffers(profile, nextPage);
          return {
            reply: [message],
            nextState: {
              flowId: FLOW_IDS.MY_OFFERS,
              step: 0,
              payload: { page: nextPage, offerIds: newOfferIds },
              updatedAt: new Date().toISOString(),
            },
          };
        }
        if (normalized === 'p' && currentPage > 0) {
          const prevPage = currentPage - 1;
          const { message, offerIds: newOfferIds } =
            await this.commands.myOffers(profile, prevPage);
          return {
            reply: [message],
            nextState: {
              flowId: FLOW_IDS.MY_OFFERS,
              step: 0,
              payload: { page: prevPage, offerIds: newOfferIds },
              updatedAt: new Date().toISOString(),
            },
          };
        }
        const choice = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : 0;
        const pageStart = currentPage * PAGE_SIZE;
        const localIndex = choice - pageStart - 1;
        if (
          choice >= pageStart + 1 &&
          choice <= pageStart + offerIds.length &&
          localIndex >= 0 &&
          localIndex < offerIds.length
        ) {
          const offerId = offerIds[localIndex];
          const offer = await this.jobOfferService.findById(offerId);
          if (!offer) {
            return {
              reply: ["*Cette offre n'existe plus. Tapez *Menu*.*"],
              clearState: true,
            };
          }
          const dateStr = offer.scheduled_at.toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
          const amountStr =
            offer.amount == null
              ? 'Prix à négocier'
              : `${offer.amount.toLocaleString('fr-FR')} FCFA`;
          const detail = [
            `*${offer.title}*`,
            `*Référence*: \`${offer.reference}\``,
            '',
            `• Date : ${dateStr}`,
            `• Montant : ${amountStr}`,
            `• Adresse : ${offer.address}`,
            `• Statut : ${translateJobOfferStatus(offer.status)}`,
            `• Candidatures : ${offer.acceptedCount ?? 0}/${offer.quantity}`,
            offer.description ? `• Description : ${offer.description}` : '',
            '',
            'R- Retour à la liste',
            'M- Menu principal',
          ]
            .filter((l) => l !== '')
            .join('\n');
          return {
            reply: [detail],
            nextState: {
              ...state,
              payload: {
                ...state.payload,
                step: 'detail',
                selectedOfferId: offerId,
              },
              updatedAt: new Date().toISOString(),
            },
          };
        }
        if ((state.payload?.step as string) === 'detail') {
          if (normalized === 'r') {
            const { message, offerIds: refreshedIds } =
              await this.commands.myOffers(profile, currentPage);
            return {
              reply: [message],
              nextState: {
                flowId: FLOW_IDS.MY_OFFERS,
                step: 0,
                payload: { page: currentPage, offerIds: refreshedIds },
                updatedAt: new Date().toISOString(),
              },
            };
          }
        }
        return { reply: [unknownCommandMessage()], nextState: state };
      },
      [FLOW_IDS.POST_CANCELLATION_ACTIONS]: async () => {
        const result = await runPostCancellationActionsFlow(
          state,
          input,
          profile,
          { prisma: this.prisma },
        );
        // Resolve the "Voir les autres candidatures" hand-off inline — we
        // have access to the candidatures-received command + state setter.
        if (result.handoff?.type === 'candidatures') {
          const cmdResult = await this.commands.candidaturesReceived(profile);
          if (cmdResult.items?.length) {
            const listState = getCandidaturesListInitialState(cmdResult.items);
            await this.botState.set(profile.id, listState);
          } else {
            await this.botState.clear(profile.id);
          }
          return { reply: [cmdResult.message] };
        }
        return result;
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

      search_by_ref: () => this.handleSearchByRefCommand(botProfile, profileId),
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

  private async handleSearchByRefCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    if (profile.profile_type !== 'WORKER') {
      return [
        '❌ Seuls les travailleurs peuvent rechercher une offre par référence. Tapez *Menu*.',
      ];
    }
    await this.botState.set(profileId, getSearchByRefInitialState());
    return [getSearchByRefPromptMessage()];
  }

  private async handleMyApplicationsCommand(
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    profileId: string,
  ): Promise<string[]> {
    const result = await this.commands.myApplications(profile);
    if (result.applicationIds.length > 0) {
      const myAppState = getMyApplicationsInitialState(
        result.applicationIds,
        'all',
        result.page,
        result.totalPages,
      );
      await this.botState.set(profileId, myAppState);
    }
    return [result.message];
  }

  private async handlePendingPaymentsCommand(
    botProfile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    const result = await this.commands.pendingPayments(botProfile);
    if (result.applicationIds.length > 0) {
      const state = getMyApplicationsInitialState(
        result.applicationIds,
        'pending_payments',
        result.page,
        result.totalPages,
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
    const { message, offerIds } = await this.commands.myOffers(profile, page);
    await this.botState.set(profileId, {
      flowId: FLOW_IDS.MY_OFFERS,
      step: 0,
      payload: { page, offerIds },
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
      expiresAt: attempt.expires_at,
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
      invoiceService: this.invoiceService,
      prisma: this.prisma,
    });
    return result.reply;
  }

  private async handleRecommendedJobsCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    const noOffersMsg = [
      '*Offres recommandées*',
      '',
      "Aucune offre recommandée pour l'instant. Complétez votre profil pour de meilleures recommandations.",
      '',
      'Tapez *Menu* pour revenir au menu principal.',
    ].join('\n');

    const offerResults = await this.interestRecommendationService.recommend(
      profile.id,
      20,
    );
    const offerIds = offerResults.map((r) => r.jobId);

    if (offerIds.length === 0) return [noOffersMsg];

    const rows = await this.prisma.jobOffer.findMany({
      where: {
        id: { in: offerIds },
        status: { in: ['ACTIVE', 'PARTIALLY_FILLED'] },
        applications: { none: { worker_id: profile.id } },
      },
      select: {
        id: true,
        reference: true,
        title: true,
        description: true,
        amount: true,
        payment_flow: true,
        address: true,
        note: true,
        scheduled_at: true,
        quantity: true,
        status: true,
        employer: { select: { reliability_score: true } },
        _count: { select: { applications: { where: { status: 'ACCEPTED' } } } },
      },
    });

    const offerMap = new Map(rows.map((o) => [o.id, o]));
    const orderedRows = offerIds
      .map((id) => offerMap.get(id))
      .filter(Boolean) as typeof rows;

    if (orderedRows.length === 0) return [noOffersMsg];

    const offerItems = orderedRows.map((o) =>
      jobOfferToOfferListItem({
        ...o,
        amount: o.amount != null ? Number(o.amount) : null,
        acceptedCount: o._count.applications,
      }),
    );

    const flowState = getRecommendedJobsInitialState(offerIds);
    await this.botState.set(profileId, flowState);

    const totalPages = Math.ceil(offerItems.length / 3);
    return [formatRecommendedList(offerItems.slice(0, 3), 0, totalPages)];
  }

  private async handleRecommendedProfilesCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    // Prefer active offer; fall back to any recent offer so signals can always be recorded
    const latestOffer =
      (await this.prisma.jobOffer.findFirst({
        where: { employer_id: profile.id, status: 'ACTIVE' },
        orderBy: { created_at: 'desc' },
        select: { id: true },
      })) ??
      (await this.prisma.jobOffer.findFirst({
        where: { employer_id: profile.id },
        orderBy: { created_at: 'desc' },
        select: { id: true },
      }));

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
          '*travailleurs recommandés*',
          '',
          "Aucun travailleur recommandé pour l'instant. Publiez une offre pour obtenir des recommandations.",
          '',
          '*Tapez 1 pour publier une offre ou Menu pour revenir.*',
        ].join('\n'),
      ];
    }

    const { reliabilityScoreMin } = await this.systemConfig.getFees();

    // Pre-filter: only keep active, verified workers meeting the score threshold
    const candidateIds = workerResults.map((r) => r.id);
    const eligibleProfiles = await this.prisma.profile.findMany({
      where: {
        id: { in: candidateIds },
        status: 'ACTIVE',
        verification_status: 'VERIFIED',
        reliability_score: { gte: reliabilityScoreMin },
      },
      select: { id: true },
    });
    const eligibleSet = new Set(eligibleProfiles.map((p) => p.id));
    const eligibleResults = workerResults.filter(
      (r) => eligibleSet.has(r.id) && r.score > 0.5,
    );

    if (eligibleResults.length === 0) {
      return [
        [
          '*travailleurs recommandés*',
          '',
          'Aucun travailleur qualifié disponible pour le moment.',
          '',
          'Tapez *Menu* pour revenir.',
        ].join('\n'),
      ];
    }

    const workerIds = eligibleResults.map((r) => r.id);
    const workerScores: Record<string, number> = Object.fromEntries(
      eligibleResults.map((r) => [r.id, r.score]),
    );

    const flowState = getRecommendedProfilesInitialState(
      workerIds,
      workerScores,
      latestOffer?.id,
    );
    await this.botState.set(profileId, flowState);

    const pageIds = workerIds.slice(0, 5);
    const workers = await this.prisma.profile.findMany({
      where: {
        id: { in: pageIds },
        status: 'ACTIVE',
        verification_status: 'VERIFIED',
        reliability_score: { gte: reliabilityScoreMin },
      },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        reliability_score: true,
        description: true,
      },
    });
    const workerMap = new Map(workers.map((w) => [w.id, w]));
    const ordered = pageIds
      .map((id) => workerMap.get(id))
      .filter(Boolean) as typeof workers;

    const lines = [
      '*travailleurs recommandés*',
      '',
      ...ordered.flatMap((w, i) => {
        const name = `${w.first_name} ${w.last_name}`.trim();
        const aiScore = Math.round((workerScores[w.id] ?? 0) * 100);
        return [
          `${i + 1}- *${name}*`,
          `    • Fiabilité : ${w.reliability_score ?? 100}/100`,
          `    • Score IA : ${aiScore}%`,
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
        whatsapp_activation_bonus_granted: true,
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
        return handleHelpCommand(commandId, {
          email: contact.email ?? '',
          phone: contact.phone ?? '',
          address: contact.address ?? '',
        });
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
