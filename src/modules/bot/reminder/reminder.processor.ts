import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import { WHATSAPP_REMINDERS_QUEUE } from '../../../common/services/queue/queue.module';
import {
  formatReminder24h,
  formatReminder2h,
  formatReminderStart,
} from '../messages/notifications.messages';
import { ApplicationStatus, JobOfferStatus } from '@prisma/client';
import { SystemConfigService } from '../../system-config/system-config.service';
import {
  BOT_STATE_KEY_PREFIX,
  BOT_STATE_TTL_SECONDS,
  FLOW_IDS,
} from '../bot.constants';
import { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import { BotNotificationService } from '../services/bot-notification.service';
import { jobStatusCheckPromptMessage } from '../flows/job-status-check.flow';
import { getCancelApplicationInitialState } from '../flows/cancel-application.flow';

const REMINDER_24H_SENT_KEY = 'reminder:sent:24h:';
const REMINDER_2H_SENT_KEY = 'reminder:sent:2h:';
const REMINDER_START_SENT_KEY = 'reminder:sent:start:';
const SENT_KEY_TTL = 48 * 60 * 60;
const SCAN_INTERVAL_MS = 15 * 60 * 1000;

// CAS: only writes if the key is absent OR current flowId matches expectedFlowId.
const LUA_CAS_SET = `
local current = redis.call('GET', KEYS[1])
if current == false then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
local ok, parsed = pcall(cjson.decode, current)
if not ok or parsed.flowId == ARGV[3] then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
return 0
`;

export type ReminderJobData =
  | { type: 'scan' }
  | { type: 'reminder_24h'; applicationId: string }
  | { type: 'reminder_2h'; applicationId: string }
  | { type: 'reminder_start'; applicationId: string }
  | {
      type: 'reminder_job_status';
      jobOfferId: string;
      employerId: string;
      applicationId: string;
      paymentFlow: string;
    };

@Injectable()
export class ReminderProcessor {
  private readonly logger = new Logger(ReminderProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsApp: WhatsAppService,
    private readonly queueService: QueueService,
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly systemConfigService: SystemConfigService,
    @Inject(forwardRef(() => ContactUnlockService))
    private readonly contactUnlockService: ContactUnlockService,
    @Inject(forwardRef(() => BotNotificationService))
    private readonly botNotification: BotNotificationService,
  ) {}

  async process(job: { id?: string; data: ReminderJobData }): Promise<void> {
    const { type } = job.data;

    if (type === 'scan') {
      await this.runScan();
      return;
    }

    if (type === 'reminder_24h') {
      await this.sendReminder24h(job.data.applicationId);
      return;
    }

    if (type === 'reminder_2h') {
      await this.sendReminder2h(job.data.applicationId);
      return;
    }

    if (type === 'reminder_start') {
      await this.sendReminderStart(job.data.applicationId);
      return;
    }

    if (type === 'reminder_job_status') {
      const { jobOfferId, employerId, applicationId, paymentFlow } = job.data;
      await this.sendJobStatusCheckReminder(
        jobOfferId,
        employerId,
        applicationId,
        paymentFlow,
      );
      return;
    }

    this.logger.warn(`Unknown reminder job type: ${String(type)}`);
  }

  private async runScan(): Promise<void> {
    await this.expireOverdueOffers();
    const now = new Date();
    const window24hStart = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const window24hEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const window2hStart = new Date(now.getTime() + (2 * 60 - 10) * 60 * 1000);
    const window2hEnd = new Date(now.getTime() + (2 * 60 + 10) * 60 * 1000);

    // Defensive cap: a single scan tick shouldn't try to enqueue more than a
    // few thousand jobs, even if upstream volume spikes.
    const SCAN_LIMIT = 5_000;
    const [apps24h, apps2h] = await Promise.all([
      this.prisma.application.findMany({
        where: {
          status: ApplicationStatus.ACCEPTED,
          job_offer: {
            scheduled_at: {
              gte: window24hStart,
              lte: window24hEnd,
            },
          },
        },
        select: { id: true },
        take: SCAN_LIMIT,
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.application.findMany({
        where: {
          status: ApplicationStatus.ACCEPTED,
          job_offer: {
            scheduled_at: {
              gte: window2hStart,
              lte: window2hEnd,
            },
          },
        },
        select: { id: true },
        take: SCAN_LIMIT,
        orderBy: { created_at: 'asc' },
      }),
    ]);

    for (const app of apps24h) {
      const key = `${REMINDER_24H_SENT_KEY}${app.id}`;
      const sent = await this.redis.get(key);
      if (!sent) {
        await this.queueService.addJob<ReminderJobData>(
          WHATSAPP_REMINDERS_QUEUE,
          { type: 'reminder_24h', applicationId: app.id },
          { jobId: `24h-${app.id}` },
        );
      }
    }

    for (const app of apps2h) {
      const key = `${REMINDER_2H_SENT_KEY}${app.id}`;
      const sent = await this.redis.get(key);
      if (!sent) {
        await this.queueService.addJob<ReminderJobData>(
          WHATSAPP_REMINDERS_QUEUE,
          { type: 'reminder_2h', applicationId: app.id },
          { jobId: `2h-${app.id}` },
        );
      }
    }

    // "start" window: scheduled_at within the last 15 minutes (job is starting now)
    const startWindowStart = new Date(now.getTime() - SCAN_INTERVAL_MS);
    const startingOffers = await this.prisma.jobOffer.findMany({
      where: {
        scheduled_at: { gte: startWindowStart, lte: now },
        status: {
          in: [
            JobOfferStatus.ACTIVE,
            JobOfferStatus.PARTIALLY_FILLED,
            JobOfferStatus.FILLED,
            JobOfferStatus.EXPIRED,
          ],
        },
      },
      select: {
        id: true,
        applications: {
          where: { status: ApplicationStatus.ACCEPTED },
          select: { id: true },
        },
      },
      take: SCAN_LIMIT,
      orderBy: { scheduled_at: 'asc' },
    });

    for (const offer of startingOffers) {
      // Expire any pending unlock attempts so WAITING_PAYMENT apps are released immediately
      const conversions = await this.contactUnlockService
        .expirePendingAttemptsForJob(offer.id)
        .catch((err) => {
          this.logger.warn(
            `Failed to expire unlock attempts for offer ${offer.id}:`,
            err,
          );
          return [];
        });
      for (const { profileId, amount } of conversions) {
        await this.botNotification
          .sendContactUnlockCreditConversionNotification(profileId, amount)
          .catch((err) =>
            this.logger.warn(
              `Credit conversion notify failed for ${profileId}:`,
              err,
            ),
          );
      }

      for (const app of offer.applications) {
        const key = `${REMINDER_START_SENT_KEY}${app.id}`;
        const sent = await this.redis.get(key);
        if (!sent) {
          await this.queueService.addJob<ReminderJobData>(
            WHATSAPP_REMINDERS_QUEUE,
            { type: 'reminder_start', applicationId: app.id },
            { jobId: `start-${app.id}` },
          );
        }
      }
    }
  }

  private async expireOverdueOffers(): Promise<void> {
    const now = new Date();
    await this.autoStartOffersWithWorkers(now);
    await this.expireEmptyOverdueOffers(now);
  }

  private async autoStartOffersWithWorkers(now: Date): Promise<void> {
    const offers = await this.prisma.jobOffer.findMany({
      where: {
        status: {
          in: [JobOfferStatus.FILLED, JobOfferStatus.PARTIALLY_FILLED],
        },
        scheduled_at: { lt: now },
        applications: {
          some: { status: ApplicationStatus.ACCEPTED },
          none: {
            status: { in: [ApplicationStatus.STARTED, ApplicationStatus.END] },
          },
        },
      },
      select: {
        id: true,
        title: true,
        payment_flow: true,
        employer_id: true,
        employer: { select: { phone: true, first_name: true } },
        applications: {
          where: { status: ApplicationStatus.ACCEPTED },
          select: { id: true },
        },
      },
    });

    if (offers.length === 0) return;

    await this.prisma.$transaction([
      this.prisma.jobOffer.updateMany({
        where: { id: { in: offers.map((o) => o.id) } },
        data: { status: JobOfferStatus.IN_PROGRESS },
      }),
      this.prisma.application.updateMany({
        where: {
          job_offer_id: { in: offers.map((o) => o.id) },
          status: ApplicationStatus.ACCEPTED,
        },
        data: { status: ApplicationStatus.STARTED },
      }),
    ]);

    for (const offer of offers) {
      await this.notifyAutoStartedOffer(offer);
    }

    this.logger.log(
      `Auto-started ${offers.length} offer(s) (FILLED/PARTIALLY_FILLED) that reached scheduled_at`,
    );
  }

  private async notifyAutoStartedOffer(offer: {
    id: string;
    title: string;
    payment_flow: string | null;
    employer_id: string;
    employer?: { phone?: string | null; first_name?: string | null } | null;
    applications: { id: string }[];
  }): Promise<void> {
    const phone = offer.employer?.phone;
    const firstName = offer.employer?.first_name ?? '';
    const firstApp = offer.applications[0];

    if (phone) {
      const autoStartText = [
        `🚀 *Mission démarrée automatiquement*`,
        ``,
        `Bonjour ${firstName}, votre offre *"${offer.title}"* a atteint l'heure prévue avec des travailleurs acceptés.`,
        ``,
        `La mission est maintenant marquée comme démarrée.`,
      ].join('\n');

      const statusCheckText = jobStatusCheckPromptMessage(
        offer.title,
        offer.payment_flow ?? 'DAILY',
      );

      const sent = await this.whatsApp
        .sendTextMessage(phone, autoStartText, offer.employer_id)
        .then(() => true)
        .catch((err) => {
          this.logger.warn(
            `Failed to notify employer ${offer.employer_id} of auto-started mission`,
            err,
          );
          return false;
        });

      if (sent && firstApp) {
        await this.whatsApp
          .sendTextMessage(phone, statusCheckText, offer.employer_id)
          .catch((err) =>
            this.logger.warn(
              `Failed to send status check prompt to employer ${offer.employer_id}`,
              err,
            ),
          );

        const stateKey = `${BOT_STATE_KEY_PREFIX}${offer.employer_id}`;
        const stateValue = JSON.stringify({
          flowId: FLOW_IDS.JOB_STATUS_CHECK,
          step: 0,
          payload: {
            jobOfferId: offer.id,
            jobTitle: offer.title,
            applicationId: firstApp.id,
            paymentFlow: offer.payment_flow ?? 'DAILY',
            snoozeCount: 0,
          },
          updatedAt: new Date().toISOString(),
        });
        await this.redis
          .eval(
            LUA_CAS_SET,
            1,
            stateKey,
            stateValue,
            String(BOT_STATE_TTL_SECONDS),
            FLOW_IDS.JOB_STATUS_CHECK,
          )
          .catch((err) =>
            this.logger.warn(
              `Failed to set job status check state for employer ${offer.employer_id}`,
              err,
            ),
          );

        // Fallback re-ping if the employer never responds — enqueued with a
        // unique jobId so BullMQ deduplicates across ticks.
        await this.queueService
          .addJob<ReminderJobData>(
            WHATSAPP_REMINDERS_QUEUE,
            {
              type: 'reminder_job_status',
              jobOfferId: offer.id,
              employerId: offer.employer_id,
              applicationId: firstApp.id,
              paymentFlow: offer.payment_flow ?? 'DAILY',
            },
            {
              jobId: `job-status-${offer.id}-autostart`,
              delay: 4 * 60 * 60 * 1000,
            },
          )
          .catch((err) =>
            this.logger.warn(
              `Failed to enqueue fallback job status reminder for offer ${offer.id}`,
              err,
            ),
          );
      }
    }
  }

  private async expireEmptyOverdueOffers(now: Date): Promise<void> {
    const overdue = await this.prisma.jobOffer.findMany({
      where: {
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
        scheduled_at: { lt: now },
        applications: {
          none: {
            status: {
              in: [
                ApplicationStatus.ACCEPTED,
                ApplicationStatus.STARTED,
                ApplicationStatus.END,
              ],
            },
          },
        },
      },
      select: {
        id: true,
        title: true,
        employer_id: true,
        employer: { select: { phone: true, first_name: true } },
        applications: {
          where: {
            status: {
              in: [
                ApplicationStatus.PENDING,
                ApplicationStatus.VIEWED,
                ApplicationStatus.WAITING_PAYMENT,
              ],
            },
          },
          select: {
            id: true,
            worker: {
              select: { id: true, phone: true, first_name: true },
            },
          },
        },
      },
    });

    if (overdue.length === 0) return;

    const overdueIds = overdue.map((o) => o.id);

    await this.prisma.$transaction([
      this.prisma.jobOffer.updateMany({
        where: { id: { in: overdueIds } },
        data: { status: JobOfferStatus.EXPIRED },
      }),
      // Cancel the uncommitted applicants left behind by the expired offers so
      // they don't linger as PENDING forever. Workers are notified below.
      this.prisma.application.updateMany({
        where: {
          job_offer_id: { in: overdueIds },
          status: {
            in: [
              ApplicationStatus.PENDING,
              ApplicationStatus.VIEWED,
              ApplicationStatus.WAITING_PAYMENT,
            ],
          },
        },
        data: {
          status: ApplicationStatus.CANCELLED,
          cancelled_at: now,
          cancellation_reason:
            'Offre expirée (date de début dépassée sans démarrage)',
        },
      }),
    ]);

    this.logger.log(
      `Expired ${overdue.length} overdue job offer(s) with no accepted workers`,
    );

    for (const offer of overdue) {
      await this.notifyExpiredOffer(offer);
      for (const app of offer.applications ?? []) {
        await this.notifyExpiredApplicant(offer.title, app.worker);
      }
    }
  }

  private async notifyExpiredApplicant(
    offerTitle: string,
    worker: {
      id: string;
      phone: string | null;
      first_name?: string | null;
    },
  ): Promise<void> {
    const phone = worker.phone;
    if (!phone) return;
    const firstName = worker.first_name ?? '';
    const text = [
      `*⏰ Offre expirée*`,
      '',
      `Bonjour ${firstName}, l'offre *"${offerTitle}"* à laquelle vous aviez postulé a expiré, votre candidature a donc été clôturée.`,
      '',
      `D'autres offres sont disponibles — tapez *MENU* pour les consulter.`,
    ].join('\n');

    await this.whatsApp
      .sendTextMessage(phone, text, worker.id)
      .catch((err) => {
        this.logger.warn(
          `Failed to notify worker ${worker.id} of expired offer`,
          err,
        );
      });
  }

  private async notifyExpiredOffer(offer: {
    id: string;
    title: string;
    employer_id: string;
    employer?: { phone?: string | null; first_name?: string | null } | null;
    applications?: { worker: { phone: string | null } }[];
  }): Promise<void> {
    const phone = offer.employer?.phone;
    if (!phone) return;
    const firstName = offer.employer?.first_name ?? '';
    const text = [
      `*⏰ Offre expirée*`,
      '',
      `Bonjour ${firstName}, votre offre *"${offer.title}"* a expiré car la date est passée sans démarrage effectif de la mission.`,
      '',
      `Que souhaitez-vous faire ?`,
      '',
      `1- Republier l'offre`,
      `2- Menu`,
    ].join('\n');

    const sent = await this.whatsApp
      .sendTextMessage(phone, text, offer.employer_id)
      .then(() => true)
      .catch((err) => {
        this.logger.warn(
          `Failed to notify employer ${offer.employer_id} of expired offer`,
          err,
        );
        return false;
      });

    if (sent) {
      // Queue this offer in the employer's republish state instead of
      // overwriting. If two offers expire in the same tick, the user
      // should be able to republish both — one at a time.
      const stateKey = `${BOT_STATE_KEY_PREFIX}${offer.employer_id}`;
      try {
        const existing = await this.redis.get(stateKey);
        const queue: string[] = (() => {
          if (!existing) return [offer.id];
          try {
            const parsed = JSON.parse(existing) as {
              flowId?: string;
              payload?: { jobOfferIds?: unknown; jobOfferId?: unknown };
            };
            // Only append when the existing state is the republish flow;
            // otherwise the user is mid-flow elsewhere — start fresh.
            if (parsed.flowId !== FLOW_IDS.REPUBLISH_EXPIRED_JOB) {
              return [offer.id];
            }
            const existingIds = Array.isArray(parsed.payload?.jobOfferIds)
              ? (parsed.payload.jobOfferIds as unknown[]).filter(
                  (v): v is string => typeof v === 'string',
                )
              : typeof parsed.payload?.jobOfferId === 'string'
                ? [parsed.payload.jobOfferId]
                : [];
            return existingIds.includes(offer.id)
              ? existingIds
              : [...existingIds, offer.id];
          } catch {
            return [offer.id];
          }
        })();

        const stateValue = JSON.stringify({
          flowId: FLOW_IDS.REPUBLISH_EXPIRED_JOB,
          step: 0,
          payload: { jobOfferIds: queue },
          updatedAt: new Date().toISOString(),
        });
        await this.redis.set(stateKey, stateValue, 'EX', BOT_STATE_TTL_SECONDS);
      } catch (err) {
        this.logger.warn(
          `Failed to enqueue republish flow state for employer ${offer.employer_id}`,
          err,
        );
      }
    }

    // Notify pending workers that the offer is no longer available
    for (const app of offer.applications ?? []) {
      if (!app.worker.phone) continue;
      await this.whatsApp
        .sendTextMessage(
          app.worker.phone,
          [
            `ℹ️ *Offre non disponible*`,
            '',
            `L'offre *${offer.title}* pour laquelle vous avez postulé est maintenant expirée.`,
            'De nouvelles offres sont disponibles — tapez *Menu* pour les consulter.',
          ].join('\n'),
        )
        .catch((err) =>
          this.logger.warn(
            `Failed to notify pending worker of expired offer ${offer.id}`,
            err,
          ),
        );
    }
  }

  private async sendJobStatusCheckReminder(
    jobOfferId: string,
    employerId: string,
    applicationId: string,
    paymentFlow: string,
  ): Promise<void> {
    // Check the offer is still IN_PROGRESS — skip if already completed/expired
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: {
        status: true,
        title: true,
        employer: { select: { phone: true } },
      },
    });
    if (!offer || offer.status !== JobOfferStatus.IN_PROGRESS) return;

    const phone = offer.employer?.phone;
    if (!phone) return;

    const text = jobStatusCheckPromptMessage(offer.title, paymentFlow);
    const sent = await this.whatsApp
      .sendTextMessage(phone, text, employerId)
      .then(() => true)
      .catch((err) => {
        this.logger.warn(
          `Failed to send job status check reminder to employer ${employerId}`,
          err,
        );
        return false;
      });

    if (sent) {
      // Refresh the bot state so the employer's reply still routes to the flow.
      // Preserve the existing snoozeCount so the 5-snooze cap is cumulative.
      const stateKey = `${BOT_STATE_KEY_PREFIX}${employerId}`;
      const existing = await this.redis.get(stateKey).catch(() => null);
      let snoozeCount = 0;
      if (existing) {
        try {
          const parsed = JSON.parse(existing) as {
            payload?: { snoozeCount?: unknown };
          };
          if (typeof parsed?.payload?.snoozeCount === 'number') {
            snoozeCount = parsed.payload.snoozeCount;
          }
        } catch {
          // malformed state — start fresh
        }
      }
      const stateValue = JSON.stringify({
        flowId: FLOW_IDS.JOB_STATUS_CHECK,
        step: 0,
        payload: {
          jobOfferId,
          jobTitle: offer.title,
          applicationId,
          paymentFlow,
          snoozeCount,
        },
        updatedAt: new Date().toISOString(),
      });
      await this.redis
        .eval(
          LUA_CAS_SET,
          1,
          stateKey,
          stateValue,
          String(BOT_STATE_TTL_SECONDS),
          FLOW_IDS.JOB_STATUS_CHECK,
        )
        .catch((err) =>
          this.logger.warn(
            `Failed to refresh job status check state for employer ${employerId}`,
            err,
          ),
        );
    }

    this.logger.log(
      `Job status check reminder sent to employer ${employerId} for offer ${jobOfferId}`,
    );
  }

  private async sendReminder24h(applicationId: string): Promise<void> {
    const key = `${REMINDER_24H_SENT_KEY}${applicationId}`;
    // Atomic SET NX EX — only one concurrent job can claim this key
    const claimed = await this.redis.set(key, '1', 'EX', SENT_KEY_TTL, 'NX');
    if (!claimed) {
      this.logger.debug(`Reminder 24h already sent for ${applicationId}`);
      return;
    }

    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        job_offer: { include: { employer: true } },
        worker: true,
      },
    });

    if (!app?.worker?.phone || app.status !== 'ACCEPTED') return;

    const fees = await this.systemConfigService.getFees();
    const text = formatReminder24h({
      offerTitle: app.job_offer.title,
      scheduledAt: app.job_offer.scheduled_at,
      address: app.job_offer.address,
      amount: Number(app.job_offer.amount),
      employerName: `${app.job_offer.employer.first_name} ${app.job_offer.employer.last_name}`,
      employerPhone: app.job_offer.employer.phone,
      cancellationThresholdHours: fees.cancellationThresholdHours,
      penaltyFcfa: fees.lateCancellationPenaltyFcfa,
    });

    await this.whatsApp.sendTextMessage(app.worker.phone, text);

    // Set bot state so the worker's reply (1=cancel, 2=keep) routes to the cancel flow.
    const workerStateKey = `${BOT_STATE_KEY_PREFIX}${app.worker_id}`;
    const cancelState = getCancelApplicationInitialState(applicationId);
    await this.redis
      .set(
        workerStateKey,
        JSON.stringify({ ...cancelState, updatedAt: new Date().toISOString() }),
        'EX',
        BOT_STATE_TTL_SECONDS,
      )
      .catch((err) =>
        this.logger.warn(
          `Failed to set cancel flow state for worker after 24h reminder ${applicationId}`,
          err,
        ),
      );

    this.logger.log(`Reminder 24h sent for application ${applicationId}`);
  }

  private async sendReminder2h(applicationId: string): Promise<void> {
    const key = `${REMINDER_2H_SENT_KEY}${applicationId}`;
    const claimed = await this.redis.set(key, '1', 'EX', SENT_KEY_TTL, 'NX');
    if (!claimed) {
      this.logger.debug(`Reminder 2h already sent for ${applicationId}`);
      return;
    }

    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        job_offer: { include: { employer: true } },
        worker: true,
      },
    });

    if (!app?.worker?.phone || app.status !== 'ACCEPTED') return;

    const text = formatReminder2h({
      offerTitle: app.job_offer.title,
      scheduledAt: app.job_offer.scheduled_at,
      address: app.job_offer.address,
      employerName: `${app.job_offer.employer.first_name} ${app.job_offer.employer.last_name}`,
      employerPhone: app.job_offer.employer.phone,
    });

    await this.whatsApp.sendTextMessage(app.worker.phone, text);
    this.logger.log(`Reminder 2h sent for application ${applicationId}`);
  }

  private async sendReminderStart(applicationId: string): Promise<void> {
    const key = `${REMINDER_START_SENT_KEY}${applicationId}`;
    const claimed = await this.redis.set(key, '1', 'EX', SENT_KEY_TTL, 'NX');
    if (!claimed) {
      this.logger.debug(`Reminder start already sent for ${applicationId}`);
      return;
    }

    const app = await this.prisma.application.findUnique({
      where: { id: applicationId },
      include: {
        job_offer: { include: { employer: true } },
        worker: true,
      },
    });

    const alreadyStarted = app?.status === ApplicationStatus.STARTED;
    if (
      !app?.worker?.phone ||
      (app.status !== ApplicationStatus.ACCEPTED && !alreadyStarted)
    )
      return;

    const previousOfferStatus = app.job_offer.status;
    const movableOfferStatuses: JobOfferStatus[] = [
      JobOfferStatus.ACTIVE,
      JobOfferStatus.PARTIALLY_FILLED,
      JobOfferStatus.FILLED,
      JobOfferStatus.EXPIRED,
    ];
    const shouldMoveOfferToInProgress =
      !alreadyStarted && movableOfferStatuses.includes(previousOfferStatus);

    // Only transition status when not already done by autoStartOffersWithWorkers.
    if (!alreadyStarted) {
      await this.prisma.$transaction(async (tx) => {
        await tx.application.update({
          where: { id: applicationId },
          data: { status: ApplicationStatus.STARTED },
        });
        if (shouldMoveOfferToInProgress) {
          await tx.jobOffer.update({
            where: { id: app.job_offer_id },
            data: { status: JobOfferStatus.IN_PROGRESS },
          });
        }
      });
    }

    try {
      const text = formatReminderStart({
        offerTitle: app.job_offer.title,
        scheduledAt: app.job_offer.scheduled_at,
        address: app.job_offer.address,
        employerName: `${app.job_offer.employer.first_name} ${app.job_offer.employer.last_name}`,
        employerPhone: app.job_offer.employer.phone,
      });

      await this.whatsApp.sendTextMessage(app.worker.phone, text);
      this.logger.log(
        `Reminder start sent for application ${applicationId} (alreadyStarted=${alreadyStarted})`,
      );
    } catch (err) {
      // Roll back status and release lock so the job retries — only when we made the transition.
      await this.redis.del(key);
      if (!alreadyStarted) {
        await this.prisma.$transaction(async (tx) => {
          await tx.application.update({
            where: { id: applicationId },
            data: { status: ApplicationStatus.ACCEPTED },
          });
          if (shouldMoveOfferToInProgress) {
            await tx.jobOffer.update({
              where: { id: app.job_offer_id },
              data: { status: previousOfferStatus },
            });
          }
        });
      }
      throw err;
    }
  }
}
