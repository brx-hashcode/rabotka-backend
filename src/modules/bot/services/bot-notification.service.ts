import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { BotStateService } from './bot-state.service';
import { getAcceptRefuseInitialState } from '../flows/accept-refuse-candidate.flow';
import {
  formatNewApplicationToEmployer,
  formatApplicationAcceptedToWorker,
  formatApplicationRejectedToWorker,
  formatCancellationToEmployer,
} from '../messages/application.messages';

@Injectable()
export class BotNotificationService {
  private readonly logger = new Logger(BotNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsApp: WhatsAppService,
    private readonly botState: BotStateService,
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
      await this.whatsApp.sendTextMessage(app.job_offer.employer.phone, text);
      const employerProfileId = app.job_offer.employer_id;
      const state = getAcceptRefuseInitialState(applicationId);
      await this.botState.set(employerProfileId, state);
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
}
