import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { BotStateService } from './bot-state.service';
import { BotInboxService } from './bot-inbox.service';
import { getAcceptRefuseInitialState } from '../flows/accept-refuse-candidate.flow';
import { getUnlockContactInitialState } from '../flows/unlock-contact.flow';
import { getRateAssignmentInitialState } from '../flows/rate-assignment.flow';
import {
  formatNewApplicationToEmployer,
  formatApplicationRejectedToWorker,
  formatCancellationToEmployer,
  formatJobCompletedToWorker,
  formatJobCancelledByEmployerToWorker,
} from '../messages/application.messages';
import {
  formatContactUnlockedMessage,
  formatContactUnlockExpiredConversion,
} from '../messages/contact-unlock.messages';
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
        include: {
          job_offer: { include: { employer: true } },
          worker: true,
        },
      });
      if (!app?.job_offer?.employer?.phone || !app.worker) return;

      const completedCount = await this.prisma.application.count({
        where: {
          worker_id: app.worker_id,
          status: 'ACCEPTED',
        },
      });

      const text = formatNewApplicationToEmployer({
        offerTitle: app.job_offer.title,
        workerName: `${app.worker.first_name} ${app.worker.last_name}`,
        workerPhone: app.worker.phone,
        workerEmail: app.worker.email,
        workerDescription: app.worker.description ?? '',
        reliabilityScore: app.worker.reliability_score,
        completedMissions: completedCount,
        scheduledAt: app.job_offer.scheduled_at,
        address: app.job_offer.address,
      });

      if (app.worker.avatar_url) {
        await this.whatsApp.sendMediaMessage(
          app.job_offer.employer.phone,
          app.worker.avatar_url,
          `*${app.worker.first_name} ${app.worker.last_name} - CANDIDAT*`,
        );
      }
      const employerProfileId = app.job_offer.employer_id;
      const activeState = await this.botState.get(employerProfileId);

      if (activeState?.flowId) {
        // Employer is mid-flow — queue into inbox instead of overwriting state
        await this.botInbox.push(employerProfileId, {
          type: 'new_application',
          applicationId,
          workerName: `${app.worker.first_name} ${app.worker.last_name}`,
          offerTitle: app.job_offer.title,
          createdAt: new Date().toISOString(),
        });
        const pendingCount = await this.botInbox.count(employerProfileId);
        const inboxNotice =
          `📬 *${pendingCount} candidature(s) en attente* dans votre boîte.` +
          `\nTerminez votre action en cours, puis tapez *candidatures* pour les traiter.`;
        await this.whatsApp.sendTextMessage(
          app.job_offer.employer.phone,
          text,
        );
        await this.whatsApp.sendTextMessage(
          app.job_offer.employer.phone,
          inboxNotice,
        );
      } else {
        // Employer is idle — set state directly so next message routes to accept/refuse
        await this.whatsApp.sendTextMessage(app.job_offer.employer.phone, text);
        const state = getAcceptRefuseInitialState(applicationId);
        await this.botState.set(employerProfileId, state);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to send new application notification to employer: ${applicationId}`,
        err,
      );
    }
  }

  async sendApplicationAcceptedToWorker(applicationId: string): Promise<void> {
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        include: {
          job_offer: { include: { employer: true } },
          worker: true,
        },
      });
      if (!app?.worker?.phone || !app.job_offer?.employer) return;

      const employerName =
        `${app.job_offer.employer.first_name} ${app.job_offer.employer.last_name}`.trim();

      const attempt =
        await this.contactUnlock.getByApplicationId(applicationId);
      if (attempt) {
        const fees = await this.systemConfig.getContactUnlockFees();
        const balance = await this.walletService.getProfileWalletBalance(
          app.worker_id,
        );
        const text = [
          `🎉 *Candidature acceptée !*`,
          ``,
          `*${employerName}* a accepté votre candidature pour l'offre "${app.job_offer.title}".`,
          ``,
          `Pour voir ses coordonnées, vous devez débloquer le contact (*${fees.workerFeeFcfa} FCFA*).`,
          `Votre solde actuel : *${balance} FCFA*`,
          ``,
          `Tapez *contact* pour accéder à ses coordonnées.`,
        ].join('\n');

        await this.whatsApp.sendTextMessage(app.worker.phone, text);

        // Pre-load unlock flow state so "contact" routes immediately
        // Guard: don't overwrite an active flow mid-conversation
        const currentState = await this.botState.get(app.worker_id);
        if (!currentState?.flowId) {
          const unlockState = getUnlockContactInitialState({
            attemptId: attempt.id,
            otherName: employerName,
            amount: fees.workerFeeFcfa,
            expiryHours: fees.expiryHours,
          });
          await this.botState.set(app.worker_id, unlockState);
        }
      } else {
        // Fallback (attempt not created yet — should not happen in normal flow)
        await this.whatsApp.sendTextMessage(
          app.worker.phone,
          [
            `🎉 *Candidature acceptée !*`,
            ``,
            `*${employerName}* a accepté votre candidature pour l'offre "${app.job_offer.title}".`,
            ``,
            `Tapez *contact* pour accéder aux coordonnées de l'employeur.`,
          ].join('\n'),
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

      if (
        employer?.phone &&
        worker &&
        attempt.employer_id !== skipId
      ) {
        await this.whatsApp.sendTextMessage(
          employer.phone,
          formatContactUnlockedMessage({
            name: `${worker.first_name} ${worker.last_name}`.trim(),
            phone: worker.phone,
            email: worker.email,
          }),
        );
      }

      if (
        worker?.phone &&
        employer &&
        attempt.worker_id !== skipId
      ) {
        await this.whatsApp.sendTextMessage(
          worker.phone,
          formatContactUnlockedMessage({
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

      await this.whatsApp.sendTextMessage(
        profile.phone,
        formatContactUnlockExpiredConversion(amount),
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
        include: { worker: true },
      });
      if (!app?.worker?.phone) return;

      const text = formatApplicationRejectedToWorker();
      await this.whatsApp.sendTextMessage(app.worker.phone, text);
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
        include: {
          job_offer: { include: { employer: true } },
          worker: true,
        },
      });
      if (!app?.job_offer?.employer?.phone || !app.worker) return;

      const fees = await this.systemConfig.getFees();
      const text = formatCancellationToEmployer({
        workerName: `${app.worker.first_name} ${app.worker.last_name}`,
        offerTitle: app.job_offer.title,
        scheduledAt: app.job_offer.scheduled_at,
        reason,
        wasLatePenalty,
        lateCancellationThresholdHours: fees.cancellationThresholdHours,
      });
      await this.whatsApp.sendTextMessage(app.job_offer.employer.phone, text);
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
        include: { job_offer: true, worker: true },
      });
      if (!app?.worker?.phone || !app.job_offer) return;
      const text = formatJobCompletedToWorker({
        offerTitle: app.job_offer.title,
        amount: Number(app.job_offer.amount ?? 0),
      });
      await this.whatsApp.sendTextMessage(app.worker.phone, text);
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

  async sendRecommendedJobNotification(
    workerId: string,
    jobOfferId: string,
  ): Promise<void> {
    try {
      const [profile, offer] = await Promise.all([
        this.prisma.profile.findUnique({
          where: { id: workerId },
          select: { phone: true, first_name: true },
        }),
        this.prisma.jobOffer.findUnique({
          where: { id: jobOfferId },
          select: {
            title: true,
            amount: true,
            address: true,
            scheduled_at: true,
          },
        }),
      ]);
      if (!profile?.phone || !offer) return;

      const dateStr = offer.scheduled_at.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const amountLine = offer.amount != null
        ? `Montant : ${Number(offer.amount).toLocaleString()} FCFA`
        : `Montant : Prix à négocier`;
      const text = [
        `*Offre recommandée pour vous, ${profile.first_name}*`,
        '',
        `*${offer.title}*`,
        amountLine,
        `Adresse : ${offer.address}`,
        `Date : ${dateStr}`,
        '',
        `Tapez *OFFRES* pour voir toutes les offres disponibles.`,
      ].join('\n');

      await this.whatsApp.sendTextMessage(profile.phone, text);
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
    const { raterProfileId, raterPhone, rateeId, assignmentId, rateeLabel, jobTitle } = params;
    const currentState = await this.botState.get(raterProfileId);
    if (currentState?.flowId) return;
    const state = getRateAssignmentInitialState(assignmentId, rateeId);
    await this.botState.set(raterProfileId, state);
    const text = [
      `*Évaluez votre mission*`,
      '',
      `La mission *${jobTitle}* est terminée.`,
      `Comment évaluez-vous *${rateeLabel}* ?`,
      '',
      'Répondez avec une note de *1* à *5*.',
    ].join('\n');
    await this.whatsApp.sendTextMessage(raterPhone, text).catch((err) =>
      this.logger.warn(
        `Failed to send rating request to ${raterPhone}`,
        err,
      ),
    );
  }

  async sendJobCancelledByEmployerToWorker(
    applicationId: string,
  ): Promise<void> {
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        include: { job_offer: true, worker: true },
      });
      if (!app?.worker?.phone || !app.job_offer) return;
      const text = formatJobCancelledByEmployerToWorker(app.job_offer.title);
      await this.whatsApp.sendTextMessage(app.worker.phone, text);
    } catch (err) {
      this.logger.warn(
        `Failed to send job cancelled by employer to worker: ${applicationId}`,
        err,
      );
    }
  }
}
