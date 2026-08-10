import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import {
  AccountStatus,
  BillingStatus,
  VerificationStatus,
} from '@prisma/client';
import { translateJobOfferStatus } from '../utils/status.utils';
import { JobOfferService } from '../../job-offer/job-offer.service';
import { ApplicationService } from '../../application/application.service';
import { BotStateService } from './bot-state.service';
import { BotRouterService } from '../router/bot-router.service';
import { BotNotificationService } from './bot-notification.service';
import { BotInboxService } from './bot-inbox.service';
import { BotDraftService } from './bot-draft.service';
import {
  welcomePlatformMessage,
  welcomeUnregisteredMessage,
} from '../messages/welcome.messages';
import { SystemConfigService } from '../../system-config/system-config.service';
import { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';
import { templateReply } from '../../../common/constants/whatsapp-carousel';
import {
  unknownCommandMessage,
  accountSuspendedBotMessage,
  hasPenaltiesBotMessage,
  penaltiesListBotMessage,
} from '../messages/menu.messages';
import type { BotProfile, BotState } from '../types/bot-state.types';
import type { FlowContext, FlowResult } from '../types/flow.types';
import { FLOW_IDS, CMD_MENU } from '../bot.constants';
import {
  runAcceptRefuseCandidateFlow,
  getAcceptRefuseInitialState,
} from '../flows/accept-refuse-candidate.flow';
import { runCancelApplicationFlow } from '../flows/cancel-application.flow';
import {
  runPayPenaltiesFlow,
  getPayPenaltiesInitialState,
} from '../flows/pay-penalties.flow';
import { PaymentService } from '../../payments/payment.service';
import { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import { WalletService } from '../../wallet/wallet.service';
import { jobOfferToOfferListItem } from '../messages/offers.messages';
import {
  runRateAssignmentFlow,
  getRateAssignmentInitialState,
} from '../flows/rate-assignment.flow';
import { MatchingService } from '../../matching/matching.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import { runRepublishExpiredJobFlow } from '../flows/republish-expired-job.flow';
import { runPostCancellationActionsFlow } from '../flows/post-cancellation-actions.flow';
import { runJobStatusCheckFlow } from '../flows/job-status-check.flow';
import { InterestSignalService } from '../../interest-graph/interest-signal.service';
import { InterestRecommendationService } from '../../interest-graph/interest-recommendation.service';
import { EngineRolloutService } from '../../recommendation-engine/engine-rollout.service';
import { RecommendationEngineService } from '../../recommendation-engine/recommendation-engine.service';
import { InvoiceService } from '../../invoice/invoice.service';
import { PortfolioService } from '../../portfolio/portfolio.service';
import { ConfigService } from '@nestjs/config';

const INACTIVE_MESSAGE = `Votre compte est créé mais pas encore activé. Cliquez sur le lien de confirmation que nous vous avons envoyé par WhatsApp pour l'activer.`;

const KYC_APPROVED_PROMPT_MESSAGE = `✅ Votre vérification KYC a été validée !`;

const KYC_REJECTED_MESSAGE = `❌ *Votre vérification KYC a été refusée.*\n\nVos documents n'ont pas pu être validés. Veuillez nous contacter pour plus d'informations.`;

const WHATSAPP_VERIFY_CODE_TTL_MINUTES = 15;

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
  ].join('\n');
}

function buildVerifyInvalidMessage(code: string): string {
  return [
    '❌ Code incorrect ou expiré.',
    '',
    `Tapez ce code *${code}* pour vérifier votre numéro WhatsApp.`,
  ].join('\n');
}

const ERROR_MESSAGE = `Une erreur est survenue. Veuillez réessayer.`;

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
    private readonly engineRollout: EngineRolloutService,
    private readonly recommendationEngine: RecommendationEngineService,
    private readonly invoiceService: InvoiceService,
    private readonly portfolioService: PortfolioService,
    private readonly queueService: QueueService,
    private readonly configService: ConfigService,
  ) {}

  async handle(
    profileId: string,
    _phone: string,
    text: string,
    preloadedProfile?: Awaited<ReturnType<typeof this.loadProfile>>,
  ): Promise<string[]> {
    const profile = preloadedProfile ?? (await this.loadProfile(profileId));
    if (!profile) {
      return [welcomeUnregisteredMessage()];
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

      // Gate: KYC must be verified before activation
      if (profile.verification_status === VerificationStatus.REJECTED) {
        return [KYC_REJECTED_MESSAGE];
      }
      if (profile.verification_status !== VerificationStatus.VERIFIED) {
        // Still under review: the account can't be activated yet, but an admin
        // may ask the user to correct their profile or file a claim during the
        // review — so those two stay reachable via a restricted 1/2 menu.
        // Handled here, before routeMessage, so this numbering can't collide
        // with the full menu's (worker '1' = Trouver une mission).
        return [this.handlePendingKycInput()];
      }

      // KYC verified + user types Menu → activate account
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
          },
        });
        await this.walletService
          .grantWelcomeCredit(profileId, profile.profile_type)
          .catch((err: unknown) =>
            this.logger.error(
              `Failed to grant welcome credit to profile ${profileId}`,
              err,
            ),
          );
        return [welcomePlatformMessage()];
      }

      // PENDING_ACTIVATION + any other input → point at the app
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
   * Input handling for a profile whose KYC is still under review: one template
   * carrying a "Gérer mon profil" button, whatever they typed. The old reply
   * was a 1/2 menu whose options each returned a webview template anyway.
   */
  private handlePendingKycInput(): string {
    return templateReply(
      'kycPendingMenu',
      WHATSAPP_TEMPLATES.kycPendingMenu.variables(),
    );
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
            data: { whatsapp_connected: true },
          }),
        ]);

        await this.walletService
          .grantWelcomeCredit(profile.id, profile.profile_type)
          .catch((err: unknown) =>
            this.logger.error(
              `Failed to grant welcome credit to profile ${profile.id}`,
              err,
            ),
          );

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

    // Already inside a payment-related flow — let it run. Contact unlock used
    // to be the other one; it is settled in the app now and has no chat flow.
    const canContinueFlow = state?.flowId === FLOW_IDS.PAY_PENALTIES;
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
        // Race: billing_status not yet refreshed; just send them back to the app.
        return [welcomePlatformMessage()];
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

      // Nothing recognised and no live flow: there is no menu to fall back
      // to any more, so the welcome card is the answer — including for an
      // expired session, where re-explaining the expiry helps nobody.
      return [welcomePlatformMessage()];
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
      verification_status: profile.verification_status,
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
      if (nextInboxItem?.type === 'pending_rating') {
        const ratingState = getRateAssignmentInitialState(
          nextInboxItem.assignmentId,
          nextInboxItem.rateeId,
        );
        await this.botState.set(profileId, ratingState);
        const ratingPrompt = [
          `*Évaluez votre mission*`,
          '',
          `La mission *${nextInboxItem.jobTitle}* est terminée.`,
          `Comment évaluez-vous *${nextInboxItem.rateeLabel}* ?`,
          '',
          'Répondez avec une note de *1* à *5*.',
        ].join('\n');
        return [...result.reply, ratingPrompt];
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
          `\n\n*${inboxCount} candidature(s) en attente* dans l’application.`;
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
      contactUnlockService: this.contactUnlockService,
      walletService: this.walletService,
      interestSignalService: this.interestSignalService,
      invoiceService: this.invoiceService,
      portfolioService: this.portfolioService,
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

      [FLOW_IDS.PAY_PENALTIES]: () =>
        runPayPenaltiesFlow(state, input, profile, ctx),

      [FLOW_IDS.REPUBLISH_EXPIRED_JOB]: () =>
        runRepublishExpiredJobFlow(state, input, profile, {
          prisma: this.prisma,
          jobOfferService: this.jobOfferService,
        }),
      [FLOW_IDS.JOB_STATUS_CHECK]: () =>
        runJobStatusCheckFlow(state, input, profile, {
          applicationService: this.applicationService,
          notificationService: this.notificationService,
          queueService: this.queueService,
          employerId: profile.id,
        }),

      [FLOW_IDS.RATE_ASSIGNMENT]: () =>
        runRateAssignmentFlow(state, input, profile, {
          prisma: this.prisma,
          applicationService: this.applicationService,
        }),

      [FLOW_IDS.POST_CANCELLATION_ACTIONS]: async () => {
        const result = await runPostCancellationActionsFlow(
          state,
          input,
          profile,
          {
            prisma: this.prisma,
            applicationService: this.applicationService,
          },
        );
        // "Voir les autres candidatures" now sends them to the app: the
        // in-chat list flow is gone, and browsing candidates belongs there.
        if (result.handoff?.type === 'candidatures') {
          return { reply: [welcomePlatformMessage()], clearState: true };
        }
        return result;
      },
    };
    const runner = runners[flowId];
    return runner ? runner() : Promise.resolve(null);
  }

  /**
   * The router can only produce `pay_penalties` now — the PAYER escape from
   * inside a live flow. Every other command was reachable only by typing into
   * the retired menu, and those journeys live in the app.
   */
  private async handleCommandRoute(
    route: { type: 'command'; commandId: string },
    _profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    profileId: string,
    botProfile: BotProfile,
  ): Promise<string[]> {
    if (route.commandId === 'pay_penalties') {
      return this.handlePayPenaltiesCommand(botProfile, profileId);
    }

    return [welcomePlatformMessage()];
  }

  private async handlePayPenaltiesCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    const unpaid = await this.applicationService.getUnpaidPenalties(profile.id);
    if (unpaid.count === 0) {
      return [`✅ *Aucune pénalité impayée.* Votre compte est en règle.`];
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

  /**
   * Recommended offer ids for a worker, from whichever engine they are bucketed
   * onto. v2 failing falls back to the legacy interest recommender rather than
   * leaving the bot with nothing to show.
   */
  private async recommendedOfferIds(
    workerId: string,
    limit: number,
  ): Promise<string[]> {
    if ((await this.engineRollout.versionFor(workerId)) === 'v2') {
      try {
        const ranked = await this.recommendationEngine.recommendJobsForWorker(
          workerId,
          limit,
        );
        if (ranked.length > 0) return ranked.map((r) => r.id);
      } catch (err) {
        this.logger.warn(`v2 ranker failed for ${workerId}`, err);
      }
    }
    const legacy = await this.interestRecommendationService.recommend(
      workerId,
      limit,
    );
    return legacy.map((r) => r.jobId);
  }

  private loadProfileWhere(where: { id: string } | { phone: string }) {
    return this.prisma.profile.findUnique({
      where,
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
        verification_status: true,
      },
    });
  }

  private loadProfile(profileId: string) {
    return this.loadProfileWhere({ id: profileId });
  }

  // Public so the inbound path can fetch the profile by phone once (for its
  // unregistered-number check) and hand it straight to handle(), instead of
  // this service re-fetching the same row by id on every message.
  loadProfileByPhone(phone: string) {
    return this.loadProfileWhere({ phone });
  }
}
