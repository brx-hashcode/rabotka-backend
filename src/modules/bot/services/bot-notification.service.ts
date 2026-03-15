import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { BotStateService } from './bot-state.service';
import { BotInboxService } from './bot-inbox.service';
import { getAcceptRefuseInitialState } from '../flows/accept-refuse-candidate.flow';
import {
  formatNewApplicationToEmployer,
  formatApplicationAcceptedToWorker,
  formatApplicationRejectedToWorker,
  formatCancellationToEmployer,
  formatJobCompletedToWorker,
  formatJobCancelledByEmployerToWorker,
} from '../messages/application.messages';
import { formatNewJobOfferToWorker } from '../messages/notifications.messages';
import { SystemConfigService } from '../../system-config/system-config.service';
import {
  QdrantService,
  COLLECTION_PROFILES,
} from '../../qdrant/qdrant.service';

@Injectable()
export class BotNotificationService {
  private readonly logger = new Logger(BotNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsApp: WhatsAppService,
    private readonly botState: BotStateService,
    private readonly botInbox: BotInboxService,
    private readonly systemConfig: SystemConfigService,
    private readonly qdrant: QdrantService,
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
          `\n\n📬 *${pendingCount} candidature(s) en attente* dans votre boîte.` +
          `\nTerminez votre action en cours, puis tapez *candidatures* pour les traiter.`;
        await this.whatsApp.sendTextMessage(
          app.job_offer.employer.phone,
          text + inboxNotice,
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

      const employerName = `${app.job_offer.employer.first_name} ${app.job_offer.employer.last_name}`;
      const text = formatApplicationAcceptedToWorker(
        employerName,
        app.job_offer.employer.phone,
      );
      await this.whatsApp.sendTextMessage(app.worker.phone, text);
    } catch (err) {
      this.logger.warn(
        `Failed to send accepted notification to worker: ${String(applicationId)}`,
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

      const text = formatCancellationToEmployer({
        workerName: `${app.worker.first_name} ${app.worker.last_name}`,
        offerTitle: app.job_offer.title,
        scheduledAt: app.job_offer.scheduled_at,
        reason,
        wasLatePenalty,
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
        amount: Number(app.job_offer.amount),
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

  async sendNewJobOfferToWorkers(jobOfferId: string): Promise<void> {
    try {
      const offer = await this.prisma.jobOffer.findUnique({
        where: { id: jobOfferId },
      });
      if (!offer) return;

      const message = formatNewJobOfferToWorker({
        title: offer.title,
        scheduledAt: offer.scheduled_at,
        amount: Number(offer.amount),
        paymentFlow: offer.payment_flow,
        address: offer.address,
        quantity: offer.quantity ?? 1,
      });

      const similarityEnabled = await this.systemConfig.isSimilarityEnabled();

      let workerPhones: string[];

      if (similarityEnabled) {
        const text = [offer.title, offer.description, offer.address].join(' ');
        const vector = await this.qdrant.embed(text);
        const hits = await this.qdrant.searchSimilar(
          COLLECTION_PROFILES,
          vector,
          50,
          { must: [{ key: 'profile_type', match: { value: 'WORKER' } }] },
        );
        const workerIds = hits.map((h) => String(h.id));
        if (workerIds.length === 0) return;

        const workers = await this.prisma.profile.findMany({
          where: {
            id: { in: workerIds },
            status: 'ACTIVE',
            profile_type: 'WORKER',
          },
          select: { phone: true },
        });
        workerPhones = workers.map((w) => w.phone);
      } else {
        const workers = await this.prisma.profile.findMany({
          where: { status: 'ACTIVE', profile_type: 'WORKER' },
          select: { phone: true },
        });
        workerPhones = workers.map((w) => w.phone);
      }

      for (const phone of workerPhones) {
        this.whatsApp
          .sendTextMessage(phone, message)
          .catch((err) =>
            this.logger.warn(
              `Failed to notify worker ${phone} of new offer`,
              err,
            ),
          );
      }

      this.logger.log(
        `New job offer ${jobOfferId} sent to ${workerPhones.length} worker(s) (similarity=${similarityEnabled})`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to broadcast new job offer ${jobOfferId} to workers`,
        err,
      );
    }
  }
}
