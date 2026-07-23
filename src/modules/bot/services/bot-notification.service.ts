import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { BotStateService } from './bot-state.service';
import { BotInboxService } from './bot-inbox.service';
import { getAcceptRefuseInitialState } from '../flows/accept-refuse-candidate.flow';
import { getUnlockContactInitialState } from '../flows/unlock-contact.flow';
import { getRateAssignmentInitialState } from '../flows/rate-assignment.flow';
import { FLOW_IDS, EMPLOYER_MENU_OPTIONS } from '../bot.constants';
import { getApplyJobNotificationState } from '../flows/apply-job.flow';
import { formatAmount } from '../messages/offers.messages';
import { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';
import { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { WalletService } from '../../wallet/wallet.service';

@Injectable()
export class BotNotificationService {
  private readonly logger = new Logger(BotNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsApp: WhatsAppService,
    private readonly botState: BotStateService,
    private readonly botInbox: BotInboxService,
    @Inject(forwardRef(() => ContactUnlockService))
    private readonly contactUnlock: ContactUnlockService,
    private readonly systemConfig: SystemConfigService,
    private readonly walletService: WalletService,
  ) {}

  async sendNewApplicationToEmployer(applicationId: string): Promise<void> {
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: {
          worker_id: true,
          job_offer: {
            select: {
              title: true,
              scheduled_at: true,
              address: true,
              employer_id: true,
              employer: {
                select: { phone: true, first_name: true, last_name: true },
              },
            },
          },
          worker: {
            select: {
              first_name: true,
              last_name: true,
              description: true,
              reliability_score: true,
              avatar_url: true,
            },
          },
        },
      });
      if (!app?.job_offer?.employer?.phone || !app.worker) return;

      const completedCount = await this.prisma.application.count({
        where: { worker_id: app.worker_id, status: 'END' },
      });

      const employerProfileId = app.job_offer.employer_id;
      const acceptRefuseState = getAcceptRefuseInitialState(applicationId);
      // CAS: only set state if no active flow; if blocked, employer is mid-conversation → inbox
      const wrote = await this.botState.setIfFlowAbsentOrMatches(
        employerProfileId,
        acceptRefuseState,
        null,
      );

      const scheduledAt = app.job_offer.scheduled_at.toLocaleDateString(
        'fr-FR',
        {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        },
      );
      const description = app.worker.description ?? '';
      const address = app.job_offer.address;
      const tpl = WHATSAPP_TEMPLATES.newApplication;
      await this.whatsApp.sendTemplateMessage(
        app.job_offer.employer.phone,
        tpl.contentSid,
        tpl.variables({
          offerTitle: app.job_offer.title,
          workerName: `${app.worker.first_name} ${app.worker.last_name}`,
          reliabilityScore: app.worker.reliability_score ?? 100,
          completedMissions: completedCount,
          workerDescription:
            description.length > 150
              ? `${description.slice(0, 150)}...`
              : description,
          scheduledAt,
          address: address.length > 80 ? `${address.slice(0, 80)}...` : address,
        }),
      );

      if (!wrote) {
        // Employer is mid-flow — queue into inbox
        await this.botInbox.push(employerProfileId, {
          type: 'new_application',
          applicationId,
          workerName: `${app.worker.first_name} ${app.worker.last_name}`,
          offerTitle: app.job_offer.title,
          createdAt: new Date().toISOString(),
        });
        const pendingCount = await this.botInbox.count(employerProfileId);
        const inboxNotice =
          `*${pendingCount} candidature(s) en attente* dans votre boîte.` +
          `\nTerminez votre action en cours, puis tapez *${EMPLOYER_MENU_OPTIONS.CANDIDATURES_RECEIVED}* (Candidatures reçues) pour les traiter.`;
        await this.whatsApp.sendTextMessage(
          app.job_offer.employer.phone,
          inboxNotice,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to send new application notification to employer: ${applicationId}`,
        err,
      );
    }
  }

  /**
   * Confirmation sent to an employer right after they publish an offer from the
   * web form. Business-initiated (usually outside the 24h window) so it uses the
   * approved rabotka_job_created template. Best-effort — only logs on failure.
   */
  async sendJobCreatedConfirmation(offerId: string): Promise<void> {
    try {
      const offer = await this.prisma.jobOffer.findUnique({
        where: { id: offerId },
        select: {
          title: true,
          reference: true,
          scheduled_at: true,
          address: true,
          amount: true,
          employer_id: true,
          employer: { select: { phone: true } },
        },
      });
      if (!offer?.employer?.phone) return;

      const dateLabel = offer.scheduled_at.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const amountLabel =
        offer.amount != null
          ? `${Number(offer.amount).toLocaleString('fr-FR')} FCFA`
          : 'Non spécifié';
      const address =
        offer.address.length > 80
          ? `${offer.address.slice(0, 80)}...`
          : offer.address;

      const body =
        `✅ *Votre offre est publiée !*\n\n` +
        `*Offre* : ${offer.title}\n` +
        `*Référence* : ${offer.reference}\n` +
        `*Date* : ${dateLabel}\n` +
        `*Adresse* : ${address}\n` +
        `*Montant* : ${amountLabel}\n\n` +
        `Partagez la référence avec un travailleur pour qu'il trouve directement votre offre. Vous serez notifié dès qu'une candidature est reçue.`;

      const tpl = WHATSAPP_TEMPLATES.jobOfferCreated;
      await this.whatsApp.sendTemplateMessage(
        offer.employer.phone,
        tpl.contentSid,
        tpl.variables({
          title: offer.title,
          reference: offer.reference,
          dateLabel,
          address,
          amountLabel,
        }),
        offer.employer_id,
        body,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send job-created confirmation for offer ${offerId}`,
        err,
      );
    }
  }

  async sendApplicationAcceptedToWorker(applicationId: string): Promise<void> {
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: {
          worker_id: true,
          job_offer: {
            select: {
              title: true,
              employer: { select: { first_name: true, last_name: true } },
            },
          },
          worker: { select: { phone: true } },
        },
      });
      if (!app?.worker?.phone || !app.job_offer?.employer) return;

      const employerName =
        `${app.job_offer.employer.first_name} ${app.job_offer.employer.last_name}`.trim();

      const attempt =
        await this.contactUnlock.getByApplicationId(applicationId);
      if (attempt) {
        const fees = await this.systemConfig.getContactUnlockFees();

        // Set unlockState BEFORE sending so that when the worker taps
        // "Continuer" (payload "continuer") the flow is already active and
        // re-shows the live payment prompt (unlock-contact.flow.ts). The
        // dynamic, balance-dependent option list cannot live in a template.
        const unlockState = getUnlockContactInitialState({
          attemptId: attempt.id,
          otherName: employerName,
          amount: fees.workerFeeFcfa,
          expiresAt: attempt.expires_at,
        });
        await this.botState.setIfFlowAbsentOrMatches(
          app.worker_id,
          unlockState,
          null,
        );

        const tpl = WHATSAPP_TEMPLATES.applicationAcceptedUnlock;
        await this.whatsApp.sendTemplateMessage(
          app.worker.phone,
          tpl.contentSid,
          tpl.variables({
            employerName,
            offerTitle: app.job_offer.title,
          }),
        );
      } else {
        const tpl = WHATSAPP_TEMPLATES.applicationAccepted;
        await this.whatsApp.sendTemplateMessage(
          app.worker.phone,
          tpl.contentSid,
          tpl.variables({
            employerName,
            offerTitle: app.job_offer.title,
          }),
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to send accepted notification to worker: ${String(applicationId)}`,
        err,
      );
    }
  }

  /**
   * Notifies both parties that contact details are visible.
   * @param skipNotifyProfileId — Skip WhatsApp to this profile (e.g. payer already gets the same text in the bot flow reply).
   */
  async sendContactUnlockedNotification(
    attemptId: string,
    options?: { skipNotifyProfileId?: string },
  ): Promise<void> {
    try {
      const attempt = await this.prisma.contactUnlockAttempt.findUnique({
        where: { id: attemptId },
      });
      if (!attempt) return;

      const skipId = options?.skipNotifyProfileId;

      const [employer, worker] = await Promise.all([
        this.prisma.profile.findUnique({
          where: { id: attempt.employer_id },
          select: {
            phone: true,
            first_name: true,
            last_name: true,
            email: true,
          },
        }),
        this.prisma.profile.findUnique({
          where: { id: attempt.worker_id },
          select: {
            phone: true,
            first_name: true,
            last_name: true,
            email: true,
          },
        }),
      ]);

      const tpl = WHATSAPP_TEMPLATES.contactUnlocked;

      if (employer?.phone && worker && attempt.employer_id !== skipId) {
        await this.whatsApp.sendTemplateMessage(
          employer.phone,
          tpl.contentSid,
          tpl.variables({
            name: `${worker.first_name} ${worker.last_name}`.trim(),
            phone: worker.phone,
            email: worker.email,
          }),
        );
      }

      if (worker?.phone && employer && attempt.worker_id !== skipId) {
        await this.whatsApp.sendTemplateMessage(
          worker.phone,
          tpl.contentSid,
          tpl.variables({
            name: `${employer.first_name} ${employer.last_name}`.trim(),
            phone: employer.phone,
            email: employer.email,
          }),
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to send contact unlocked notification: ${attemptId}`,
        err,
      );
    }
  }

  async sendContactUnlockCreditConversionNotification(
    profileId: string,
    amount: number,
  ): Promise<void> {
    try {
      const profile = await this.prisma.profile.findUnique({
        where: { id: profileId },
        select: { phone: true },
      });
      if (!profile?.phone) return;

      const tpl = WHATSAPP_TEMPLATES.unlockExpiredConversion;
      await this.whatsApp.sendTemplateMessage(
        profile.phone,
        tpl.contentSid,
        tpl.variables({ amount }),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send credit conversion notification to ${profileId}`,
        err,
      );
    }
  }

  async sendApplicationRejectedToWorker(applicationId: string): Promise<void> {
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: { worker: { select: { phone: true } } },
      });
      if (!app?.worker?.phone) return;

      const tpl = WHATSAPP_TEMPLATES.applicationRejected;
      await this.whatsApp.sendTemplateMessage(
        app.worker.phone,
        tpl.contentSid,
        tpl.variables(),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send rejected notification to worker: ${String(applicationId)}`,
        err,
      );
    }
  }

  async sendCancellationToEmployer(
    applicationId: string,
    reason: string | null,
    wasLatePenalty: boolean,
  ): Promise<void> {
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: {
          job_offer: {
            select: {
              id: true,
              title: true,
              scheduled_at: true,
              employer_id: true,
              employer: { select: { phone: true } },
            },
          },
          worker: { select: { first_name: true, last_name: true } },
        },
      });
      if (!app?.job_offer?.employer?.phone || !app.worker) return;

      const fees = await this.systemConfig.getFees();
      const date = app.job_offer.scheduled_at.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const penaltyStatus = wasLatePenalty
        ? `Cette annulation tardive (moins de ${fees.cancellationThresholdHours}h avant) a entraîné une pénalité pour le worker.`
        : 'Aucune pénalité n’a été appliquée (annulation dans les délais).';
      const tpl = WHATSAPP_TEMPLATES.cancellation;
      await this.whatsApp.sendTemplateMessage(
        app.job_offer.employer.phone,
        tpl.contentSid,
        tpl.variables({
          workerName: `${app.worker.first_name} ${app.worker.last_name}`,
          offerTitle: app.job_offer.title,
          date,
          reason: reason ?? '',
          penaltyStatus,
        }),
      );

      // Set the POST_CANCELLATION_ACTIONS state so 1/2/3 actually do
      // something. CAS-write so we don't clobber an in-flight flow.
      const employerId = app.job_offer.employer_id;
      await this.botState
        .setIfFlowAbsentOrMatches(
          employerId,
          {
            flowId: FLOW_IDS.POST_CANCELLATION_ACTIONS,
            step: 0,
            payload: {
              jobOfferId: app.job_offer.id,
              jobOfferTitle: app.job_offer.title,
            },
            updatedAt: new Date().toISOString(),
          },
          null,
        )
        .catch(() => {});
    } catch (err) {
      this.logger.warn(
        `Failed to send cancellation notification to employer: ${String(applicationId)}`,
        err,
      );
    }
  }

  async sendJobCompletedToWorker(applicationId: string): Promise<void> {
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: {
          job_offer: { select: { title: true } },
          worker: { select: { phone: true } },
        },
      });
      if (!app?.worker?.phone || !app.job_offer) return;
      const tpl = WHATSAPP_TEMPLATES.jobCompleted;
      await this.whatsApp.sendTemplateMessage(
        app.worker.phone,
        tpl.contentSid,
        tpl.variables({ offerTitle: app.job_offer.title }),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send job completed notification to worker: ${applicationId}`,
        err,
      );
    }
  }

  async sendMessage(phone: string, text: string): Promise<void> {
    await this.whatsApp.sendTextMessage(phone, text);
  }

  async sendKycValidatedMessage(
    phone: string,
    firstName: string,
    _profileType: 'WORKER' | 'EMPLOYER',
  ): Promise<void> {
    // Same KYC-approved message as kyc.service.ts — reuse the approved `kyc`
    // template rather than a free-form send (recipient is out of window).
    const tpl = WHATSAPP_TEMPLATES.kyc;
    await this.whatsApp.sendTemplateMessage(
      phone,
      tpl.contentSid,
      tpl.variables(firstName),
    );
  }

  async sendRecommendedJobNotification(
    workerId: string,
    jobOfferId: string,
  ): Promise<void> {
    try {
      const [profile, offer] = await Promise.all([
        this.prisma.profile.findUnique({
          where: { id: workerId },
          select: {
            phone: true,
            first_name: true,
            status: true,
            profile_type: true,
          },
        }),
        this.prisma.jobOffer.findUnique({
          where: { id: jobOfferId },
          select: {
            title: true,
            amount: true,
            payment_flow: true,
            address: true,
            scheduled_at: true,
          },
        }),
      ]);
      if (!profile?.phone || !offer) return;
      if (profile.profile_type !== 'WORKER' || profile.status !== 'ACTIVE')
        return;

      const applyState = getApplyJobNotificationState(jobOfferId);
      const stateSet = await this.botState.setIfFlowAbsentOrMatches(
        workerId,
        applyState,
        null,
      );
      if (!stateSet) return;

      const dateStr = offer.scheduled_at.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const tpl = WHATSAPP_TEMPLATES.jobRecommendation;
      await this.whatsApp.sendTemplateMessage(
        profile.phone,
        tpl.contentSid,
        tpl.variables({
          firstName: profile.first_name,
          title: offer.title,
          amount: formatAmount(
            offer.amount != null ? Number(offer.amount) : null,
            offer.payment_flow,
          ),
          address: offer.address,
          date: dateStr,
        }),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send recommended job notification to worker ${workerId}`,
        err,
      );
    }
  }

  async sendRatingRequest(params: {
    raterProfileId: string;
    raterPhone: string;
    rateeId: string;
    assignmentId: string;
    rateeLabel: string;
    jobTitle: string;
  }): Promise<void> {
    const {
      raterProfileId,
      raterPhone,
      rateeId,
      assignmentId,
      rateeLabel,
      jobTitle,
    } = params;
    const state = getRateAssignmentInitialState(assignmentId, rateeId);
    const written = await this.botState.setIfFlowAbsentOrMatches(
      raterProfileId,
      state,
      null,
    );
    if (!written) {
      // User is mid-flow — defer the rating request so it fires when their flow ends.
      await this.botInbox.push(raterProfileId, {
        type: 'pending_rating',
        assignmentId,
        rateeId,
        rateeLabel,
        jobTitle,
        createdAt: new Date().toISOString(),
      });
      return;
    }
    const tpl = WHATSAPP_TEMPLATES.ratingRequest;
    await this.whatsApp
      .sendTemplateMessage(
        raterPhone,
        tpl.contentSid,
        tpl.variables({ jobTitle, rateeLabel }),
      )
      .catch((err) =>
        this.logger.warn(`Failed to send rating request to ${raterPhone}`, err),
      );
  }

  async sendJobCancelledByEmployerToWorker(
    applicationId: string,
  ): Promise<void> {
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: {
          job_offer: { select: { title: true } },
          worker: { select: { phone: true } },
        },
      });
      if (!app?.worker?.phone || !app.job_offer) return;
      const tpl = WHATSAPP_TEMPLATES.jobCancelledByEmployer;
      await this.whatsApp.sendTemplateMessage(
        app.worker.phone,
        tpl.contentSid,
        tpl.variables({ offerTitle: app.job_offer.title }),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send job cancelled by employer to worker: ${applicationId}`,
        err,
      );
    }
  }
}
