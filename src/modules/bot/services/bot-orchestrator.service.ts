import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { VovaService } from '../../rag/vova.service';
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
import { isAcknowledgement } from '../../rag/agent/offer';
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
  supportCardBotMessage,
  hasPenaltiesBotMessage,
  openAppBotMessage,
} from '../messages/menu.messages';
import type { BotProfile, BotState } from '../types/bot-state.types';
import type { FlowContext, FlowResult } from '../types/flow.types';
import {
  FLOW_IDS,
  CMD_MENU,
  CMD_NAVIGATION,
  CMD_PAY,
  CMD_SUPPORT,
} from '../bot.constants';
import { stripChatFormattingChars } from '../utils/chat-input';
import {
  runAcceptRefuseCandidateFlow,
  getAcceptRefuseInitialState,
} from '../flows/accept-refuse-candidate.flow';
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

/**
 * How stale `last_login_at` must be before a bot message rewrites it.
 *
 * Fifteen minutes: long enough that working through a menu costs one UPDATE
 * instead of a dozen, short enough that the column still reads as "today".
 */
const LOGIN_STAMP_THROTTLE_MS = 15 * 60 * 1000;

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
    /**
     * forwardRef because the assistant closes a cycle back to here:
     * BotModule → VovaModule → ContactUnlockModule → (forwardRef) BotModule.
     * The same knot `worker.module.ts` documents, tied one module further out.
     */
    @Inject(forwardRef(() => VovaService))
    private readonly vova: VovaService,
  ) {}

  /**
   * Move `last_login_at` for a profile that just used the bot.
   *
   * Throttled rather than written per message. Someone working through a menu
   * sends a dozen messages in a minute, and an UPDATE on each would turn a read
   * path into a write path for no gain — the column is read by admins at
   * day granularity, so minute accuracy is already more than anyone uses.
   *
   * Fire-and-forget, like the auth-side stamp: the reply is what the user is
   * waiting for, and a failed timestamp must never cost them a response.
   */
  private recordBotActivity(profileId: string, lastLoginAt: Date | null): void {
    const now = Date.now();
    if (lastLoginAt && now - lastLoginAt.getTime() < LOGIN_STAMP_THROTTLE_MS) {
      return;
    }
    void this.prisma.profile
      .update({
        where: { id: profileId },
        data: { last_login_at: new Date(now) },
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `Failed to record bot activity for profile ${profileId}`,
          err instanceof Error ? err.message : String(err),
        ),
      );
  }

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

    // Any bot message counts as a sign-in. A WhatsApp message arrives from a
    // verified number, which is the same proof the OTP flow establishes — and
    // for a WhatsApp-first product the bot IS the session, so a user who lives
    // entirely in `/start` and `/support` was reading as "never signed in".
    //
    // Placed before every branch below, so it covers commands, menu numbers and
    // free text alike rather than needing a call per handler.
    this.recordBotActivity(profile.id, profile.last_login_at);

    const allowed: string[] = [
      AccountStatus.ACTIVE,
      AccountStatus.SUSPENDED,
      AccountStatus.PENDING_ACTIVATION,
    ];
    if (!allowed.includes(profile.status)) {
      return [INACTIVE_MESSAGE];
    }

    const botProfile = this.toBotProfile(profile);

    // Ahead of the suspended short-circuit, so it answers in every account
    // state. The suspension and KYC-rejection templates tell people to type
    // "/support", and those people are by definition not ACTIVE.
    if (
      CMD_SUPPORT.includes(stripChatFormattingChars(text).trim().toLowerCase())
    ) {
      return [await this.supportCardMessage()];
    }

    // A suspended account is not a closed one: the suspension copy itself says
    // « vous pouvez toujours consulter votre compte », and `MINTABLE_STATUSES`
    // mints a login code for SUSPENDED — so these people have somewhere to go
    // and, until now, no way to ask anything about it. Every message returned
    // the same support card.
    //
    // The assistant answers their free text; `/start` and the other
    // deterministic words return the suspension card, whose button opens the
    // app. `/support` is already handled above, in every account state.
    if (profile.status === AccountStatus.SUSPENDED) {
      const vovaReply = await this.vovaReplyOrNull(profile, text);
      // The card FOLLOWS the answer rather than replacing it. The prompt used
      // to make the model close with « tapez */start* », so the door was
      // already offered on every reply — this offers the same door as a button
      // instead of a word to type, at the same frequency.
      if (vovaReply) {
        return this.wantsAppCard(text)
          ? [...vovaReply, this.openAppCard(profile.first_name)]
          : vovaReply;
      }
      return [this.openAppCard(profile.first_name)];
    }

    const normalizedInput = text.trim().toLowerCase();

    // Two separate walls, and this block holds both: an ACTIVE profile whose
    // number is not linked yet, and any profile that has not been activated.
    // The condition used to be `!whatsapp_connected` alone, which worked only
    // because signup left that flag false — now that it is set at signup, the
    // KYC wall below has to key on `status` or a PENDING_ACTIVATION profile
    // would walk straight into the full menu.
    if (
      profile.status !== AccountStatus.ACTIVE ||
      !profile.whatsapp_connected
    ) {
      return this.handleNotActivated(profileId, text, profile, normalizedInput);
    }

    if (profile.billing_status !== BillingStatus.CLEAR) {
      return this.handleBlockedByPenalties(profileId, text, profile);
    }

    return this.routeMessage(profileId, text, profile, botProfile);
  }

  /**
   * Everything behind the two walls: an ACTIVE profile whose number is not
   * linked yet, and any profile that has not been activated.
   *
   * Extracted from `handle` rather than left inline — the KYC branch inside it
   * grew a VoVa call, and `handle` was already the longest method here.
   */
  private async handleNotActivated(
    profileId: string,
    text: string,
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    normalizedInput: string,
  ): Promise<string[]> {
    // ACTIVE but WhatsApp not yet verified — issue a 4-digit code inline, and
    // when the user echoes it back, activate immediately. Deliberately ahead of
    // the assistant: the expected reply here is a 4-digit code, which has no
    // business reaching a model.
    // (A genuinely SUSPENDED account is already short-circuited by the caller.)
    if (profile.status === AccountStatus.ACTIVE) {
      return this.handleInlineWhatsappVerification(profile, text);
    }

    // Gate: KYC must be verified before activation.
    //
    // The gate decides ACTIVATION, not whether the person deserves an answer.
    // It used to decide both: whatever someone under review typed, they got the
    // same card and never reached `routeMessage`, the only caller of VoVa. So
    // the PENDING and REJECTED branches of `buildSystemPrompt` — « ne lui
    // promets ni résultat ni délai », the whole refused-KYC path — were
    // unreachable for the exact population they were written for, and « j'ai un
    // problème » was answered with a button.
    //
    // The deterministic words keep their card; everything else is free text,
    // and free text is what the assistant is for.
    if (profile.verification_status !== VerificationStatus.VERIFIED) {
      const vovaReply = await this.vovaReplyOrNull(profile, text);

      // The same door for both, and it now rides WITH the assistant's answer
      // rather than only instead of it. Which wall they are behind, and why, is
      // the assistant's to say — it has the status and the admin's own words.
      // This card only has to open the app, and it does so in one tap instead
      // of asking for a typed command.
      if (vovaReply) {
        return this.wantsAppCard(text)
          ? [...vovaReply, this.openAppCard(profile.first_name)]
          : vovaReply;
      }
      return [this.openAppCard(profile.first_name)];
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
          // First activation wins — see `activated_at` on the model.
          activated_at: profile.activated_at ?? new Date(),
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

  /**
   * The one card an account behind a wall can get: a button that opens the app.
   *
   * Three cards before this — the suspension, the refusal, the KYC-pending
   * review — each repeating in template copy what the assistant now says
   * itself. Copy in two places drifts, and the template half is the half that
   * needs Meta's approval to change.
   *
   * ONE thing was lost with them, and it is worth naming: the admin's REASON.
   * `suspension_reason` and `rejection_reason` sit in `NEVER_EXPOSE`
   * (`intents/projections.ts`), so the assistant cannot read them and cannot
   * repeat them. The user still receives the reason once — in the template an
   * admin sends at the moment of suspending or refusing — but can no longer
   * get it back by asking the bot. That is a deliberate trade, not an
   * oversight; lift it by taking those fields out of `NEVER_EXPOSE`.
   *
   * So this one says nothing about the wall. It existed for a single reason: a
   * bare link does not open WhatsApp's in-app browser, only a button does. That
   * no longer requires a template — `openAppBotMessage` builds the card
   * free-form and keeps `openApp` only for a window that shut in between.
   *
   * The three explanatory templates stay: they are what an admin sends when
   * suspending an account or refusing a dossier, which is outside any window
   * and genuinely business-initiated.
   *
   * No `loginCode` argument: `openApp` declares `urlSuffixMode: 'shortlink'`,
   * so the outbound processor mints the one-time code against the bare
   * destination on the way out.
   */
  /**
   * Should the app card ride along with this reply?
   *
   * NOT ON A CLOSE. « merci », « non merci », « non laisse », « je vois » — the
   * person has finished, and appending a button to that is the behaviour a real
   * transcript ends with: « Regarde vous avez déjà refusé donc svp arrête avec
   * vos messages bête la ». Every one of her replies, including the refusals,
   * carried the card.
   *
   * The card is a door, and a door is worth offering to somebody going
   * somewhere. Offering it to somebody leaving is just noise, and noise from a
   * business account is what gets a number blocked.
   */
  private wantsAppCard(text: string): boolean {
    return !isAcknowledgement(text);
  }

  private openAppCard(firstName: string): string {
    return openAppBotMessage(firstName);
  }

  /**
   * Let VoVa answer, unless the text is one of the words the product prints.
   *
   * `null` means "answer it yourself" — the caller keeps its own default, which
   * is the point: the assistant is a first refusal on free text, never the
   * owner of a reply. Every VoVa failure already returns null on its side
   * (disabled, out of bucket, timed out, thrown), so the deterministic answer
   * survives the model being down.
   *
   * NOT on the menu vocabulary: `BotRouterService` returns `unknown` for
   * everything when no flow is live, so « menu », « start » and a bare « / »
   * arrive here too, and routing the documented entry point through a model
   * would make the one command every template tells users to type depend on a
   * provider being up. `isDeterministicCommand` matches those EXACTLY, so
   * « bonjour », « 1 » and « j'ai un problème » still reach the assistant.
   *
   * Shared by `routeMessage` and the KYC wall. It was inline in the former, and
   * that is precisely how the latter went without it: a profile under review
   * returned its card before `routeMessage` ever ran, so the PENDING and
   * REJECTED branches written into `buildSystemPrompt` had never once executed.
   */
  private async vovaReplyOrNull(
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
    text: string,
  ): Promise<string[] | null> {
    if (
      isDeterministicCommand(
        stripChatFormattingChars(text).trim().toLowerCase(),
      )
    ) {
      return null;
    }
    return this.vova.handle(
      {
        id: profile.id,
        first_name: profile.first_name,
        profile_type: profile.profile_type,
        verification_status: profile.verification_status,
        // Suspended reaches here now. Without the status the prompt would tell
        // them the app is theirs to use and offer to find them a mission.
        status: profile.status,
      },
      text,
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
            data: {
              whatsapp_connected: true,
              activated_at: profile.activated_at ?? now,
            },
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
   * A profile with unpaid penalties (billing_status != CLEAR).
   *
   * Penalties are paid in the app, so every message gets the payment card —
   * after VoVa's answer when there is one, as for suspended accounts. The chat
   * used to run its own payment path (« tapez 1 », a list, a method); a person
   * still inside it from before is released here rather than left in a flow
   * that no longer exists.
   */
  private async handleBlockedByPenalties(
    profileId: string,
    text: string,
    profile: NonNullable<Awaited<ReturnType<typeof this.loadProfile>>>,
  ): Promise<string[]> {
    await this.releaseChatPaymentState(profileId);

    const card = hasPenaltiesBotMessage(profile.first_name);
    const vovaReply = await this.vovaReplyOrNull(profile, text);
    return vovaReply ? [...vovaReply, card] : [card];
  }

  /** Drops a state left by the retired chat payment path, if any. */
  private async releaseChatPaymentState(profileId: string): Promise<void> {
    const state = await this.botState.get(profileId);
    if (
      state?.flowId === FLOW_IDS.PAY_PENALTIES ||
      state?.flowId === FLOW_IDS.PENALTY_GATE
    ) {
      await this.botState.clear(profileId);
    }
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
        const flowReply = await this.runFlow(
          route.flowId,
          route.state,
          text,
          botProfile,
          profileId,
        );
        // `null` means the flow is gone and its state has just been cleared.
        // Fall through rather than answering: the person asked something, and
        // they should get the answer they would have got with no flow open.
        if (flowReply) return flowReply;
      }

      if (route.type === 'command') {
        return this.handleCommandRoute(route, profile, profileId, botProfile);
      }

      // Nothing recognised and no live flow. Before this, the welcome card was
      // the whole answer — so a worker typing « j'ai un problème » got a menu.
      const vovaReply = await this.vovaReplyOrNull(profile, text);
      if (vovaReply) return vovaReply;

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
      profile_type: profile.profile_type,
      status: profile.status,
      reliability_score: profile.reliability_score,
      verification_status: profile.verification_status,
    };
  }

  /** Replies, or `null` when the flow no longer exists and the caller should
   *  answer as though none had been open. */
  private async runFlow(
    flowId: string,
    state: BotState,
    input: string,
    profile: BotProfile,
    profileId: string,
  ): Promise<string[] | null> {
    const result = await this.executeFlow(flowId, state, input, profile);
    if (!result) {
      // A state naming a flow that no longer exists. Retiring a flow leaves
      // these behind in Redis for as long as their TTL, and the state alone is
      // enough to capture every message: the router hands ALL input to the
      // active flow, so the reply here used to be a dead end that kept the
      // state — trapping the person for a day, with even « / » swallowed by the
      // flow before it could reach the menu.
      //
      // Clearing and returning null is what makes a removed flow a non-event:
      // the message is answered as if no flow had been open, which is the
      // truth. Warn, not debug — reaching this means a flow was deleted while
      // people were mid-conversation, and that is worth seeing in the log.
      this.logger.warn(`Flow ${flowId} no longer exists — clearing state`);
      await this.botState.clear(profileId).catch(() => undefined);
      return null;
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
      // Retired: penalties are paid in the app. A state armed before the
      // change gets the payment card once and is cleared.
      [FLOW_IDS.PAY_PENALTIES]: () =>
        Promise.resolve({
          reply: [hasPenaltiesBotMessage(profile.first_name)],
          clearState: true,
        }),

      [FLOW_IDS.RATE_ASSIGNMENT]: () =>
        runRateAssignmentFlow(state, input, profile, {
          prisma: this.prisma,
          applicationService: this.applicationService,
        }),
    };
    const runner = runners[flowId];
    return runner ? runner() : Promise.resolve(null);
  }

  /**
   * Commands the router can produce: « payer », and the marketing opt-out.
   *
   * The opt-out pair is answered inline rather than through a flow — the whole
   * point of STOP is that it takes one message and no further steps.
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

    if (route.commandId === 'marketing_opt_out') {
      return this.setMarketingOptOut(profileId, true);
    }

    if (route.commandId === 'marketing_opt_in') {
      return this.setMarketingOptOut(profileId, false);
    }

    return [welcomePlatformMessage()];
  }

  /**
   * Record — or undo — "stop sending me announcements".
   *
   * Scope is stated in the reply, because an opt-out people do not trust is an
   * opt-out they replace with a block: the messages that concern their own
   * missions keep coming, and that is the honest thing to say rather than a
   * bare « c'est noté ».
   */
  private async setMarketingOptOut(
    profileId: string,
    optOut: boolean,
  ): Promise<string[]> {
    await this.prisma.profile.update({
      where: { id: profileId },
      data: { marketing_opt_out_at: optOut ? new Date() : null },
    });

    return optOut
      ? [
          'C’est noté. Vous ne recevrez plus d’annonces ni de suggestions de ' +
            'missions sur WhatsApp.\n\nLes messages concernant vos ' +
            'candidatures, vos paiements et vos missions continuent — ils vous ' +
            'concernent directement.\n\nRépondez *Reprendre* pour les ' +
            'réactiver.',
        ]
      : [
          'C’est réactivé. Vous recevrez à nouveau les annonces et les ' +
            'suggestions de missions.',
        ];
  }

  private async handlePayPenaltiesCommand(
    profile: BotProfile,
    profileId: string,
  ): Promise<string[]> {
    await this.releaseChatPaymentState(profileId);
    const unpaid = await this.applicationService.getUnpaidPenalties(profile.id);
    if (unpaid.count === 0) {
      return [`✅ *Aucune pénalité impayée.* Votre compte est en règle.`];
    }
    return [hasPenaltiesBotMessage(profile.first_name)];
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
        // The admin's own words, so the bot can say WHY rather than just that.
        suspension_reason: true,
        billing_status: true,
        reliability_score: true,
        whatsapp_connected: true,
        whatsapp_activation_bonus_granted: true,
        verification_status: true,
        // The admin's own words again, for the refusal card — same reasoning as
        // `suspension_reason` above, and the bot could not say WHY without it.
        rejection_reason: true,
        // Read, not written, on the hot path: `recordBotActivity` compares
        // against it to decide whether the stamp is due, and the activation
        // paths preserve `activated_at` rather than resetting it.
        last_login_at: true,
        activated_at: true,
      },
    });
  }

  /**
   * Support contacts, with the suspension reason when there is one.
   *
   * One helper because two paths reach it — an explicit `/support` and a
   * suspended profile saying anything at all — and they must not drift into
   * telling the reader different things.
   */
  private async supportCardMessage(opts?: {
    suspended?: boolean;
    reason?: string | null;
  }): Promise<string> {
    const contact = await this.systemConfig.getContactInfo();
    return supportCardBotMessage(
      {
        email: contact.email ?? '',
        phone: contact.phone ?? '',
        address: contact.address ?? '',
      },
      opts,
    );
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

/**
 * Words the bot answers itself, with no model in the path.
 *
 * `CMD_SUPPORT` is not here because `handle()` already answers it before any of
 * this, in every account state.
 */
function isDeterministicCommand(normalizedInput: string): boolean {
  // EXACT match only, deliberately.
  //
  // Prefix matching swallowed the product's own front door: the landing page's
  // WhatsApp CTA sends « Bonjour Rabotka, je cherche une opportunité ou un
  // profil adapté », which begins with "bonjour " and was therefore answered
  // with the menu card — the first message a new user ever sends, and the one
  // that states their intent, never reached the assistant.
  //
  // `CMD_NAVIGATION` rather than `CMD_MENU`: a bare « bonjour » now reaches the
  // assistant too, which introduces itself and asks what the person needs. Only
  // the "show me the thing" words stay deterministic, because templates print
  // them and they must not wait on a model.
  return [...CMD_NAVIGATION, ...CMD_PAY].includes(normalizedInput);
}
