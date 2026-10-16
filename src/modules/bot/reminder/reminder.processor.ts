import {
  Injectable,
  Logger,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { jobLocationLabel } from '../../../common/utils/job-location.util';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { QueueService } from '../../../common/services/queue/queue.service';
import { WHATSAPP_REMINDERS_QUEUE } from '../../../common/services/queue/queue.module';
import {
  autoStartedFreeForm,
  formatDate,
  offerExpiredApplicantFreeForm,
  offerExpiredEmployerFreeForm,
  reminder24hFreeForm,
  reminderStartFreeForm,
  statusCheckFreeForm,
} from '../messages/notifications.messages';
import {
  NotificationDispatcher,
  type FreeFormMessage,
} from '../../notification-dispatch/notification-dispatcher.service';
import type { TemplateKey, TemplateParams } from '../../whatsapp/contracts';
import { APP_TIMEZONE } from '../utils/parse-date-time';
import {
  ApplicationCancelledBy,
  ApplicationStatus,
  EmploymentType,
  JobOfferStatus,
} from '@prisma/client';
import { cancellationPatch } from '../../application/application.constants';
import { closeRecruitedOfferTx } from '../../job-offer/utils/close-recruited-offer';
import { SystemConfigService } from '../../system-config/system-config.service';
import { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import { BotNotificationService } from '../services/bot-notification.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  notificationDedupeKey,
  notifyProfile,
} from '../../profile-notification/profile-notification.events';

const REMINDER_24H_SENT_KEY = 'reminder:sent:24h:';
const REMINDER_START_SENT_KEY = 'reminder:sent:start:';
const SENT_KEY_TTL = 48 * 60 * 60;
/** Absorbs job retries of the same in-app notification. */
const IN_APP_DEDUPE_SECONDS = 7 * 24 * 60 * 60;
const SCAN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How long an offer with no closing date stays open.
 *
 * CDI/CDD/STAGE offers carry no date, so the expiry scan has nothing to compare
 * against and they would never retire. Thirty days is long enough that a
 * genuine permanent search is not cut short, and short enough that a forgotten
 * offer does not haunt the feed indefinitely.
 */
const UNDATED_OFFER_TTL_DAYS = 30;

/**
 * How long a staffed CDD/CDI/STAGE waits for its employer to confirm the hire
 * before the system closes it on their behalf.
 *
 * Without a backstop the dead end this whole flow exists to fix simply moves one
 * state later: the offer parks in FILLED, and since rating hangs off the
 * assignment being COMPLETED, neither side can ever rate the other.
 *
 * A week is long enough that a busy employer is not overruled for being slow,
 * and closing is the low-stakes direction — it opens the rating and stops the
 * offer lingering, and nothing about it is destructive.
 */
const FILLED_CONFIRMATION_GRACE_DAYS = 7;

export type ReminderJobData =
  | { type: 'scan' }
  | { type: 'reminder_24h'; applicationId: string }
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
    // Appended and @Optional(): the spec constructs this processor
    // positionally, and `notify()` falls back to the template without it —
    // which is what every send here did before the dispatcher existed.
    @Optional()
    private readonly dispatcher?: NotificationDispatcher,
    // In-app notifications. Optional for the same positional-spec reason.
    @Optional()
    private readonly events?: EventEmitter2,
  ) {}

  /**
   * Send the cheap way inside the 24h window, the approved way always.
   *
   * Mirrors `BotNotificationService.notify`. Reminders are the other half of
   * the notification volume, and the worker on a mission tomorrow is precisely
   * the person likely to have written to the bot today.
   */
  private async notify<K extends TemplateKey>(params: {
    phone: string;
    profileId?: string;
    key: K;
    params: TemplateParams<K>;
    freeForm?: FreeFormMessage;
  }): Promise<boolean> {
    if (!this.dispatcher) {
      return this.whatsApp.sendTemplateMessage(
        params.phone,
        params.key,
        params.params,
        params.profileId,
      );
    }

    const { sent } = await this.dispatcher.send({
      phone: params.phone,
      ...(params.profileId ? { profileId: params.profileId } : {}),
      template: { key: params.key, params: params.params },
      ...(params.freeForm ? { freeForm: params.freeForm } : {}),
    });
    return sent;
  }

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

    // Defensive cap: a single scan tick shouldn't try to enqueue more than a
    // few thousand jobs, even if upstream volume spikes.
    const SCAN_LIMIT = 5_000;
    const apps24h = await this.prisma.application.findMany({
      where: {
        status: ApplicationStatus.ACCEPTED,
        job_offer: {
          scheduled_at: { gte: window24hStart, lte: window24hEnd },
          // "Your job starts in 24 hours" is only true of a MISSION. On the
          // other types this date is the day applications close, and the work
          // may have begun weeks earlier or not be arranged yet.
          employment_type: EmploymentType.MISSION,
        },
      },
      select: { id: true },
      take: SCAN_LIMIT,
      orderBy: { created_at: 'asc' },
    });

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

    // "start" window: scheduled_at within the last 15 minutes (job is starting now)
    const startWindowStart = new Date(now.getTime() - SCAN_INTERVAL_MS);
    const startingOffers = await this.prisma.jobOffer.findMany({
      where: {
        scheduled_at: { gte: startWindowStart, lte: now },
        // Same reason as the 24h window: a closing deadline is not a start
        // time, and `sendReminderStart` reads `scheduled_at` as an hour of day
        // to announce.
        employment_type: EmploymentType.MISSION,
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

    // Ongoing engagements last. They are independent of everything above — the
    // scans for MISSION reminders and expiry share no rows with these — and
    // running them at the end keeps the earlier queries at the call positions
    // `reminder.processor.spec.ts` asserts on.
    await this.stopRecruitingOnDeadline(now);
    await this.closeRecruitedOffersAfterGrace(now);
  }

  private async expireOverdueOffers(): Promise<void> {
    const now = new Date();
    await this.autoStartOffersWithWorkers(now);
    await this.expireEmptyOverdueOffers(now);
  }

  /**
   * An ongoing engagement whose application deadline has passed, with at least
   * one person hired, stops recruiting.
   *
   * `expireEmptyOverdueOffers` deliberately will not touch these — it requires
   * zero accepted applications, because expiring an offer somebody was hired on
   * would be wrong. But that left a `quantity: 3` offer with one hire in
   * PARTIALLY_FILLED forever: never full, so never closed by the fill path, and
   * never empty, so never expired. This is the missing exit.
   *
   * FILLED rather than COMPLETED: the employer still gets to say whether the
   * hire actually stuck, exactly as they would had the offer filled normally.
   */
  private async stopRecruitingOnDeadline(now: Date): Promise<void> {
    const overdue = await this.prisma.jobOffer.findMany({
      where: {
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
        employment_type: { not: EmploymentType.MISSION },
        scheduled_at: { lt: now },
        applications: {
          some: {
            status: {
              in: [ApplicationStatus.ACCEPTED, ApplicationStatus.STARTED],
            },
          },
        },
      },
      select: { id: true },
    });

    if (overdue.length === 0) return;

    const ids = overdue.map((o) => o.id);
    await this.prisma.$transaction([
      this.prisma.jobOffer.updateMany({
        where: { id: { in: ids } },
        data: { status: JobOfferStatus.FILLED },
      }),
      // Whoever had not committed yet is out — recruiting is over. Mirrors what
      // `rejectLeftoversIfOfferFilled` does when an offer fills normally.
      this.prisma.application.updateMany({
        where: {
          job_offer_id: { in: ids },
          status: {
            in: [
              ApplicationStatus.PENDING,
              ApplicationStatus.VIEWED,
              ApplicationStatus.WAITING_PAYMENT,
            ],
          },
        },
        data: { status: ApplicationStatus.REJECTED, rejected_at: now },
      }),
    ]);

    this.logger.log(
      `Stopped recruiting on ${overdue.length} ongoing engagement(s) past their application deadline`,
    );
  }

  /**
   * Closes a staffed ongoing engagement the employer never got round to
   * confirming.
   *
   * Without this the dead end simply moves one state later: the offer sits in
   * FILLED, and because rating hangs off the assignment being COMPLETED,
   * neither side can ever rate the other — which is the whole problem this was
   * meant to solve.
   *
   * Anchored on `updated_at` for want of a `filled_at` column. It is imprecise
   * — any write to the row restarts the clock — but it is imprecise in the safe
   * direction: an unrelated update delays the sweep, giving the employer longer
   * to answer, and never closes an offer early.
   */
  private async closeRecruitedOffersAfterGrace(now: Date): Promise<void> {
    const graceCutoff = new Date(
      now.getTime() - FILLED_CONFIRMATION_GRACE_DAYS * 24 * 60 * 60 * 1000,
    );
    const stale = await this.prisma.jobOffer.findMany({
      where: {
        status: JobOfferStatus.FILLED,
        employment_type: { not: EmploymentType.MISSION },
        updated_at: { lt: graceCutoff },
      },
      select: { id: true },
    });

    if (stale.length === 0) return;

    for (const offer of stale) {
      await this.prisma
        .$transaction((tx) => closeRecruitedOfferTx(tx, offer.id))
        .catch((err) =>
          this.logger.warn(
            `Grace-period close failed for offer ${offer.id}:`,
            err,
          ),
        );
    }

    this.logger.log(
      `Closed ${stale.length} staffed engagement(s) unconfirmed after ${FILLED_CONFIRMATION_GRACE_DAYS} days`,
    );
  }

  private async autoStartOffersWithWorkers(now: Date): Promise<void> {
    const offers = await this.prisma.jobOffer.findMany({
      where: {
        status: {
          in: [JobOfferStatus.FILLED, JobOfferStatus.PARTIALLY_FILLED],
        },
        scheduled_at: { lt: now },
        // Only a MISSION begins on its date. Every type carries a date now, so
        // without this a staffed CDI whose application window closed would be
        // flipped to IN_PROGRESS and its worker asked whether the job is
        // finished — for an engagement that may have years left to run.
        employment_type: EmploymentType.MISSION,
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
          // The worker confirms completion now, so the status-check prompt goes
          // to them rather than the employer — which needs their phone.
          select: {
            id: true,
            worker_id: true,
            worker: { select: { phone: true } },
          },
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
    applications: {
      id: string;
      worker_id: string;
      worker?: { phone?: string | null } | null;
    }[];
  }): Promise<void> {
    notifyProfile(this.events, {
      recipientId: offer.employer_id,
      dedupeKey: notificationDedupeKey('mission-started', offer.id),
      dedupeTtlSeconds: IN_APP_DEDUPE_SECONDS,
      input: {
        type: 'MISSION_STARTED',
        jobOfferId: offer.id,
        jobTitle: offer.title,
      },
    });
    for (const app of offer.applications) {
      notifyProfile(this.events, {
        recipientId: app.worker_id,
        dedupeKey: notificationDedupeKey('status-check', offer.id, app.id),
        dedupeTtlSeconds: IN_APP_DEDUPE_SECONDS,
        input: {
          type: 'MISSION_STATUS_CHECK',
          jobOfferId: offer.id,
          jobTitle: offer.title,
        },
      });
    }

    const phone = offer.employer?.phone;

    if (phone) {
      const params = { offerTitle: offer.title, jobOfferId: offer.id };
      const sent = await this.notify({
        phone,
        profileId: offer.employer_id,
        key: 'autoStarted',
        params,
        freeForm: autoStartedFreeForm(params),
      })
        .then(() => true)
        .catch((err) => {
          this.logger.warn(
            `Failed to notify employer ${offer.employer_id} of auto-started mission`,
            err,
          );
          return false;
        });

      if (!sent) return;

      // Completion is the worker's call, so the "is it finished?" prompt goes
      // to each hired worker rather than the employer. On a multi-worker offer
      // every one of them is asked: the offer closes only once all have
      // confirmed, so a single answer is not enough.
      for (const app of offer.applications) {
        await this.promptWorkerForStatus(offer, app);
      }
    }
  }

  /** Asks one hired worker to confirm their own mission is finished. */
  private async promptWorkerForStatus(
    offer: {
      id: string;
      title: string;
      payment_flow: string | null;
      employer_id: string;
    },
    app: {
      id: string;
      worker_id: string;
      worker?: { phone?: string | null } | null;
    },
  ): Promise<void> {
    const workerPhone = app.worker?.phone;
    if (!workerPhone) return;

    const statusParams = { jobTitle: offer.title, jobOfferId: offer.id };
    await this.notify({
      phone: workerPhone,
      profileId: app.worker_id,
      key: 'statusCheck',
      params: statusParams,
      freeForm: statusCheckFreeForm(statusParams),
    }).catch((err) =>
      this.logger.warn(
        `Failed to send status check prompt to worker ${app.worker_id}`,
        err,
      ),
    );

    // No bot state is armed alongside this template. It carries a CTA button
    // and no menu, so a state expecting "1 = done / 2 = later" would only make
    // the bot act on messages the worker never meant as answers. Confirming a
    // mission happens in the app.

    // Fallback re-ping if the worker never responds — enqueued with a unique
    // jobId so BullMQ deduplicates across ticks.
    await this.queueService
      .addJob<ReminderJobData>(
        WHATSAPP_REMINDERS_QUEUE,
        {
          type: 'reminder_job_status',
          jobOfferId: offer.id,
          employerId: offer.employer_id,
          applicationId: app.id,
          paymentFlow: offer.payment_flow ?? 'DAILY',
        },
        {
          jobId: `job-status-${offer.id}-${app.worker_id}-autostart`,
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

  private async expireEmptyOverdueOffers(now: Date): Promise<void> {
    // An offer with no closing date — CDI, CDD, stage — would otherwise never
    // expire, because this scan is the ONLY thing that ever retires an offer
    // and it filters on a date those rows do not have. They would sit ACTIVE in
    // the feed forever. Age since posting is the honest substitute.
    const undatedCutoff = new Date(
      now.getTime() - UNDATED_OFFER_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    const overdue = await this.prisma.jobOffer.findMany({
      where: {
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
        OR: [
          { scheduled_at: { lt: now } },
          { scheduled_at: null, created_at: { lt: undatedCutoff } },
        ],
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
        // SYSTEM, so an expired offer never bars the worker from a republish.
        data: cancellationPatch({
          by: ApplicationCancelledBy.SYSTEM,
          at: now,
          reason: 'Offre expirée (date de début dépassée sans démarrage)',
        }),
      }),
    ]);

    this.logger.log(
      `Expired ${overdue.length} overdue job offer(s) with no accepted workers`,
    );

    for (const offer of overdue) {
      await this.notifyExpiredOffer(offer);
      for (const app of offer.applications ?? []) {
        await this.notifyExpiredApplicant(offer, app.worker);
      }
    }
  }

  private async notifyExpiredApplicant(
    offer: { id: string; title: string },
    worker: {
      id: string;
      phone: string | null;
      first_name?: string | null;
    },
  ): Promise<void> {
    const offerTitle = offer.title;
    notifyProfile(this.events, {
      recipientId: worker.id,
      dedupeKey: notificationDedupeKey('offer-expired', offer.id, worker.id),
      dedupeTtlSeconds: IN_APP_DEDUPE_SECONDS,
      input: {
        type: 'JOB_OFFER_EXPIRED',
        recipientRole: 'WORKER',
        jobOfferId: offer.id,
        jobTitle: offerTitle,
      },
    });
    const phone = worker.phone;
    if (!phone) return;
    await this.notify({
      phone,
      profileId: worker.id,
      key: 'offerExpiredApplicant',
      params: { offerTitle },
      freeForm: offerExpiredApplicantFreeForm({ offerTitle }),
    }).catch((err) => {
      this.logger.warn(
        `Failed to notify worker ${worker.id} of expired offer`,
        err,
      );
    });
  }

  /**
   * Tells the EMPLOYER their offer expired, and arms the republish flow.
   *
   * It used to also loop the offer's applicants and send them
   * `offerUnavailableWorker` — while the caller was already sending each of
   * them `offerExpiredApplicant` from the same list, for the same event. Every
   * pending applicant therefore got two billed templates saying the same
   * thing: "the offer is no longer available" and "the offer expired, your
   * application is closed". The second is the accurate one — it names the
   * consequence, and the transaction above really does cancel the application
   * — so the vaguer duplicate went.
   *
   * The duplicate was also conditional on something unrelated: the early
   * return below means workers were only messaged when the EMPLOYER had a
   * phone number. Notifying applicants belongs to the caller, which does it
   * per worker and passes the worker id along for the delivery log.
   *
   * This leaves `offerUnavailableWorker` with no sender. Its registry entry
   * and its approved Meta template stay put — an approved template costs
   * nothing to keep, and deleting the entry would break the binding check.
   */
  private async notifyExpiredOffer(offer: {
    id: string;
    title: string;
    employer_id: string;
    employer?: { phone?: string | null; first_name?: string | null } | null;
  }): Promise<void> {
    notifyProfile(this.events, {
      recipientId: offer.employer_id,
      dedupeKey: notificationDedupeKey(
        'offer-expired',
        offer.id,
        offer.employer_id,
      ),
      dedupeTtlSeconds: IN_APP_DEDUPE_SECONDS,
      input: {
        type: 'JOB_OFFER_EXPIRED',
        recipientRole: 'EMPLOYER',
        jobOfferId: offer.id,
        jobTitle: offer.title,
      },
    });
    const phone = offer.employer?.phone;
    if (!phone) return;
    // No bot state is armed alongside this template. Republishing is a CTA away
    // in the app, and an armed queue would let a stray "1" republish an offer
    // the employer had finished with.
    const expiredParams = { offerTitle: offer.title, jobOfferId: offer.id };
    await this.notify({
      phone,
      profileId: offer.employer_id,
      key: 'offerExpiredEmployer',
      params: expiredParams,
      freeForm: offerExpiredEmployerFreeForm(expiredParams),
    }).catch((err) =>
      this.logger.warn(
        `Failed to notify employer ${offer.employer_id} of expired offer`,
        err,
      ),
    );
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
      select: { status: true, title: true },
    });
    if (!offer || offer.status !== JobOfferStatus.IN_PROGRESS) return;

    // The worker confirms completion, so the re-ping goes to them. Skip once
    // this worker has already answered — their application leaves ACCEPTED /
    // STARTED the moment they confirm, and chasing them again would be noise.
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: {
        status: true,
        worker_id: true,
        worker: { select: { phone: true } },
      },
    });
    if (
      !application ||
      (application.status !== ApplicationStatus.ACCEPTED &&
        application.status !== ApplicationStatus.STARTED)
    ) {
      return;
    }

    const phone = application.worker?.phone;
    if (!phone) return;

    const workerId = application.worker_id;
    const repingParams = { jobTitle: offer.title, jobOfferId };
    const sent = await this.notify({
      phone,
      profileId: workerId,
      key: 'statusCheck',
      params: repingParams,
      freeForm: statusCheckFreeForm(repingParams),
    })
      .then(() => true)
      .catch((err) => {
        this.logger.warn(
          `Failed to send job status check reminder to worker ${workerId}`,
          err,
        );
        return false;
      });

    if (!sent) return;

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

    notifyProfile(this.events, {
      recipientId: app.worker_id,
      dedupeKey: notificationDedupeKey('reminder', 'tomorrow', applicationId),
      dedupeTtlSeconds: IN_APP_DEDUPE_SECONDS,
      input: {
        type: 'MISSION_REMINDER',
        when: 'TOMORROW',
        applicationId,
        jobTitle: app.job_offer.title,
        schedule: formatDate(app.job_offer.scheduled_at),
        address: jobLocationLabel(app.job_offer),
      },
    });

    const fees = await this.systemConfigService.getFees();
    const params = {
      offerTitle: app.job_offer.title,
      date: formatDate(app.job_offer.scheduled_at),
      address: jobLocationLabel(app.job_offer),
      amount: Number(app.job_offer.amount).toLocaleString('fr-FR'),
      employerName: `${app.job_offer.employer.first_name} ${app.job_offer.employer.last_name}`,
      employerPhone: app.job_offer.employer.phone,
      cancellationThresholdHours: String(fees.cancellationThresholdHours),
      penaltyFcfa: fees.lateCancellationPenaltyFcfa.toLocaleString('fr-FR'),
      // URL suffix: the reminder deep-links to this exact mission rather
      // than dropping the worker on a list to find it.
      applicationId,
    };
    await this.notify({
      phone: app.worker.phone,
      profileId: app.worker_id,
      key: 'reminder24h',
      params,
      freeForm: reminder24hFreeForm(params),
    });

    // No bot state is armed here. This used to open the cancel flow so the
    // worker's "1 = cancel / 2 = keep" quick reply had somewhere to land, but
    // the template now carries a single CTA button and cancelling happens in
    // the app. Arming a flow whose menu is never shown meant the next message
    // the worker sent — a question about the hours, a "merci" — was read as an
    // answer to that phantom menu and cancelled the mission outright.
    this.logger.log(`Reminder 24h sent for application ${applicationId}`);
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
      const time = app.job_offer.scheduled_at!.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: APP_TIMEZONE,
      });
      const params = {
        offerTitle: app.job_offer.title,
        time,
        address: jobLocationLabel(app.job_offer),
        employerName: `${app.job_offer.employer.first_name} ${app.job_offer.employer.last_name}`,
        employerPhone: app.job_offer.employer.phone,
        applicationId,
      };
      notifyProfile(this.events, {
        recipientId: app.worker_id,
        dedupeKey: notificationDedupeKey('reminder', 'now', applicationId),
        dedupeTtlSeconds: IN_APP_DEDUPE_SECONDS,
        input: {
          type: 'MISSION_REMINDER',
          when: 'NOW',
          applicationId,
          jobTitle: app.job_offer.title,
          schedule: `aujourd’hui à ${time}`,
          address: params.address,
        },
      });
      await this.notify({
        phone: app.worker.phone,
        profileId: app.worker_id,
        key: 'reminderStart',
        params,
        freeForm: reminderStartFreeForm(params),
      });
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
