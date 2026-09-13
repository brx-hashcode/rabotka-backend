import {
  Injectable,
  Logger,
  Optional,
  forwardRef,
  Inject,
} from '@nestjs/common';
import Redis from 'ioredis';
import { ContactUnlockStatus } from '@prisma/client';
import { jobLocationLabel } from '../../../common/utils/job-location.util';
import {
  REDIS_CONNECTION,
  REDIS_KEY_PREFIX,
} from '../../../common/services/redis/redis.constants';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { WhatsAppFeedbackService } from '../../whatsapp/feedback/whatsapp-feedback.service';
import { BotInboxService } from './bot-inbox.service';
import { formatAmount } from '../messages/offers.messages';
import { WHATSAPP_TEMPLATES } from '../../../common/constants/whatsapp-templates';
import { ContactUnlockService } from '../../contact-unlock/contact-unlock.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { WalletService } from '../../wallet/wallet.service';
import { ContractService } from '../../contract/contract.service';
import { WhatsAppDocumentService } from '../../whatsapp/documents/whatsapp-document.service';

@Injectable()
export class BotNotificationService {
  private readonly logger = new Logger(BotNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => WhatsAppService))
    private readonly whatsApp: WhatsAppService,
    private readonly botInbox: BotInboxService,
    @Inject(forwardRef(() => ContactUnlockService))
    private readonly contactUnlock: ContactUnlockService,
    private readonly systemConfig: SystemConfigService,
    private readonly walletService: WalletService,
    @Inject(forwardRef(() => WhatsAppFeedbackService))
    private readonly feedback: WhatsAppFeedbackService,
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    // Appended, and @Optional(): the specs construct this service positionally,
    // so a mid-list parameter shifts every mock after it and one they do not
    // pass must not be a hard dependency.
    @Optional()
    private readonly contractService?: ContractService,
    @Optional()
    private readonly whatsAppDocuments?: WhatsAppDocumentService,
  ) {}

  /**
   * Paces "someone applied" so one offer cannot bill the employer once per
   * applicant. Keyed by OFFER, not by employer: two offers are two different
   * pieces of news, and one filling up must not silence the other.
   */
  private newApplicationCooldownKey(jobOfferId: string): string {
    return `new_application_notify:${jobOfferId}`;
  }

  /**
   * Tells the employer a worker applied. Notification only — the decision is
   * made on the web at `/candidatures/:id`, which the template's button opens.
   *
   * No longer arms the accept/refuse flow or queues an inbox entry: the approved
   * template carries a URL button instead of « Accepter » / « Refuser », so
   * there is nothing for a typed reply to drive.
   *
   * PACED per offer. This used to fire once per application with nothing in
   * front of it, so an offer with twenty-five candidates sent the employer
   * twenty-five billed templates in real time, each opening the same page. The
   * message is a nudge, not the channel — its button lands on the offer, where
   * every applicant is listed — so the first one within the window does the
   * whole job. `matching.new_application_notify_cooldown_minutes` tunes it
   * without a deploy, and `0` restores a message per application.
   */
  async sendNewApplicationToEmployer(applicationId: string): Promise<void> {
    // Held outside the try so the catch can hand it back: a send that threw
    // must not silence the offer for the rest of the window over a message
    // nobody received.
    let claimedKey: string | null = null;
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: {
          worker_id: true,
          job_offer: {
            select: {
              id: true,
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

      // Claimed BEFORE the counting query below, so a paced-out application
      // costs neither a message nor a round trip.
      const cooldownMinutes =
        await this.systemConfig.getNewApplicationNotifyCooldownMinutes();
      if (cooldownMinutes > 0) {
        const key = this.newApplicationCooldownKey(app.job_offer.id);
        const claimed = await this.redis.set(
          key,
          '1',
          'EX',
          cooldownMinutes * 60,
          'NX',
        );
        if (claimed === null) {
          this.logger.debug(
            `Employer already notified about offer ${app.job_offer.id} within ` +
              `${cooldownMinutes}min — skipping notification for application ${applicationId}`,
          );
          return;
        }
        claimedKey = key;
      }

      const completedCount = await this.prisma.application.count({
        where: { worker_id: app.worker_id, status: 'END' },
      });

      const scheduledAt = app.job_offer.scheduled_at?.toLocaleDateString(
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
      const address = jobLocationLabel(app.job_offer);
      const tpl = WHATSAPP_TEMPLATES.newApplication;
      await this.whatsApp.sendTemplateMessage(
        app.job_offer.employer.phone,
        'newApplication',
        {
          offerTitle: app.job_offer.title,
          workerName: `${app.worker.first_name} ${app.worker.last_name}`,
          reliabilityScore: app.worker.reliability_score ?? 100,
          completedMissions: completedCount,
          workerDescription:
            description.length > 150
              ? `${description.slice(0, 150)}...`
              : description,
          scheduledAt: scheduledAt ?? 'Non précisée',
          address: address.length > 80 ? `${address.slice(0, 80)}...` : address,
          // URL suffix for the CTA button (/candidatures/{{8}}). Ignored by the
          // pre-approval template, so this is safe either side of the cutover.
          applicationId,
        },
        app.job_offer.employer_id,
      );
    } catch (err) {
      // Hand the window back. Keeping it would let one failed send suppress
      // every later applicant on this offer for the rest of the cooldown, so a
      // transient WhatsApp error would cost the employer news it never got.
      if (claimedKey) {
        await this.redis.del(claimedKey).catch(() => undefined);
      }
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

        // No chat state is armed. This used to pre-arm the unlock flow so a
        // "Continuer" quick-reply could re-show a balance-dependent option list
        // in the chat; the template carries a URL button now and the worker
        // settles up in the app, so arming a flow only left a stale state for
        // the next thing they typed to fall into.
        await this.whatsApp.sendTemplateMessage(
          app.worker.phone,
          'applicationAcceptedUnlock',
          {
            employerName,
            offerTitle: app.job_offer.title,
            // URL suffix: the worker settles their share on the web now.
            applicationId,
          },
          app.worker_id,
        );
      } else {
        await this.whatsApp.sendTemplateMessage(
          app.worker.phone,
          'applicationAccepted',
          {
            employerName,
            offerTitle: app.job_offer.title,
          },
          app.worker_id,
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

      // The unlock is the moment the product either delivered or did not, so it
      // is the honest place to ask for feedback — and the template now carries
      // the Flow on its own button, so the ask rides along with the contact
      // details instead of arriving as a second message. That second message
      // used to be `feedback.requestFeedback`, a free-form interactive send:
      // WhatsApp rejects those outside the 24h service window (131047), which
      // is precisely where anyone who paid on the web sits.
      if (employer?.phone && worker && attempt.employer_id !== skipId) {
        await this.whatsApp.sendTemplateMessage(
          employer.phone,
          'contactUnlocked',
          {
            name: `${worker.first_name} ${worker.last_name}`.trim(),
            phone: worker.phone,
            email: worker.email,
            flowToken: this.feedback.mintFlowToken(attempt.employer_id),
          },
        );
      }

      if (worker?.phone && employer && attempt.worker_id !== skipId) {
        await this.whatsApp.sendTemplateMessage(
          worker.phone,
          'contactUnlocked',
          {
            name: `${employer.first_name} ${employer.last_name}`.trim(),
            phone: employer.phone,
            email: employer.email,
            flowToken: this.feedback.mintFlowToken(attempt.worker_id),
          },
        );
      }

      // The contract, after both contact messages and behind its own failure
      // boundary. It needs a CONTRACT template row, a renderable mission period
      // and an object round trip, none of which the contact details depend on —
      // and the contact details are what these two just paid for.
      await this.sendMissionContractDocument(attempt, employer, worker).catch(
        (err: unknown) =>
          this.logger.warn(
            `Contract document delivery failed for ${attemptId}:`,
            err,
          ),
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send contact unlocked notification: ${attemptId}`,
        err,
      );
    }
  }

  /**
   * The mission contract, to BOTH parties, as a real PDF attachment.
   *
   * CREATES THE CONTRACT ROW FIRST, because at this moment there may not be
   * one. `ContactUnlockService.markApplicationAcceptedAfterUnlock` flips
   * WAITING_PAYMENT → ACCEPTED without creating a contract — only
   * `ApplicationService.accept()` does, plus a lazy backfill on read — so an
   * application that reached ACCEPTED through payment alone has never had one.
   * `ContractService.create` is idempotent on `application_id` (which is
   * `@unique`), so this is a backfill and not a second row.
   *
   * Out of scope: the recommendation unlock, which has no application and
   * therefore no contract. "Contact unlocked" reads the same in both flows, but
   * only this one is a mission.
   */
  private async sendMissionContractDocument(
    attempt: {
      id: string;
      status: ContactUnlockStatus;
      application_id: string;
      employer_id: string;
      worker_id: string;
    },
    employer: { phone: string; first_name: string } | null,
    worker: { phone: string; first_name: string } | null,
  ): Promise<void> {
    // Gated where the contact details are not: sending a contract for a
    // half-paid attempt would be a real bug, not a cosmetic one.
    if (attempt.status !== ContactUnlockStatus.UNLOCKED) return;
    if (!this.contractService || !this.whatsAppDocuments) return;
    if (!this.whatsApp.supports('templateDocumentHeader')) return;

    const contract = await this.contractService.create(attempt.application_id);

    // `downloadAsAdmin`, not `download`: the latter enforces a
    // requesting-profile check we would have to satisfy twice, and it flips the
    // contract to DOWNLOADED. That status records whether a party pulled their
    // own copy; a push delivery must not consume it. Both share the same Redis
    // PDF cache, so the second party's copy is a cache hit.
    const { buffer, filename } = await this.contractService.downloadAsAdmin(
      contract.id,
    );

    const offerTitle = await this.missionTitleFor(attempt.application_id);

    const parties = [
      { profile: employer, id: attempt.employer_id },
      { profile: worker, id: attempt.worker_id },
    ];

    for (const party of parties) {
      const phone = party.profile?.phone;
      if (!phone) continue;

      // Long window, unlike the agreement's: the unlock path genuinely re-runs
      // (BullMQ retries, and a multi-seat employer payment can surface one
      // attempt in both `status` and `newlyUnlocked`). A mission unlocks once,
      // so there is no legitimate second contract delivery.
      const claimKey = `${REDIS_KEY_PREFIX}wa:doc:contract:${contract.id}:${party.id}`;
      let claimed = false;
      try {
        claimed =
          (await this.redis.set(claimKey, '1', 'EX', 30 * 24 * 3600, 'NX')) !==
          null;
      } catch {
        claimed = true; // Redis down: a duplicate beats silence.
      }
      if (!claimed) continue;

      try {
        await this.whatsAppDocuments.send({
          phone,
          profileId: party.id,
          template: 'missionContractDocument',
          params: {
            firstName: party.profile?.first_name ?? '',
            offerTitle,
          },
          pdf: buffer,
          filename,
          storageKey: `contract/${contract.id}.pdf`,
        });
      } catch (err) {
        // Release only this party's claim, and still try the other one.
        await this.redis.del(claimKey).catch(() => undefined);
        this.logger.warn(
          `[contract] WhatsApp delivery failed for profile ${party.id}`,
          err,
        );
      }
    }
  }

  /** The job title the contract is for, for the template's second variable. */
  private async missionTitleFor(applicationId: string): Promise<string> {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: { job_offer: { select: { title: true } } },
    });
    return application?.job_offer?.title ?? 'votre mission';
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
        'unlockExpiredConversion',
        { amount },
        profileId,
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
        'applicationRejected',
        undefined,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send rejected notification to worker: ${String(applicationId)}`,
        err,
      );
    }
  }

  /**
   * Tells a worker their hire was undone by the employer.
   *
   * Without this the mission simply vanishes from their app with no
   * explanation — and under the re-application rule they also need telling
   * that this one does NOT bar them from applying again, unlike a cancellation
   * they make themselves.
   *
   * Free-form rather than a template, deliberately: there is no approved
   * template for this, and a free-form reply costs nothing inside the 24h
   * service window. The trade-off is that a worker who has not messaged in 24h
   * will not receive it — the in-app state is still correct either way. A
   * template would make delivery unconditional and is worth adding separately.
   */
  async sendCancellationToWorker(
    applicationId: string,
    reason: string | null,
  ): Promise<void> {
    try {
      const app = await this.prisma.application.findUnique({
        where: { id: applicationId },
        select: {
          job_offer: { select: { title: true } },
          worker: { select: { phone: true, first_name: true } },
        },
      });
      if (!app?.worker?.phone || !app.job_offer) return;

      const lines = [
        `*${app.worker.first_name}*, l'employeur a annulé votre mission « ${app.job_offer.title} ».`,
      ];
      if (reason) lines.push(`Motif : ${reason}`);
      lines.push(
        'Aucune pénalité pour vous, et vous pouvez postuler à nouveau à cette offre si elle est republiée.',
      );

      await this.whatsApp.sendTextMessage(app.worker.phone, lines.join('\n\n'));
    } catch (err) {
      this.logger.warn(
        `Failed to send employer-cancellation notice to worker: ${String(applicationId)}`,
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
      const date = app.job_offer.scheduled_at?.toLocaleDateString('fr-FR', {
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
        'cancellation',
        {
          workerName: `${app.worker.first_name} ${app.worker.last_name}`,
          offerTitle: app.job_offer.title,
          date: date ?? 'Non précisée',
          reason: reason ?? '',
          penaltyStatus,
          jobOfferId: app.job_offer.id,
        },
      );

      // No bot state is armed here. This used to open a 1/2/3 action menu, back
      // when the employer received a text message that printed one; the CTA
      // template replaced it and the menu was never shown again. Managing the
      // offer after a cancellation happens in the app.
    } catch (err) {
      this.logger.warn(
        `Failed to send cancellation notification to employer: ${String(applicationId)}`,
        err,
      );
    }
  }

  async sendMessage(phone: string, text: string): Promise<void> {
    await this.whatsApp.sendTextMessage(phone, text);
  }

  /**
   * Sends the job-recommendation template, reporting whether it went out.
   *
   * The boolean is load-bearing rather than informational: the caller claims a
   * per-worker cooldown before calling, and has to release it again when nothing
   * was sent. A void return made "delivered", "skipped as ineligible" and
   * "provider threw" indistinguishable, so a Twilio failure muted a worker for
   * an hour over a message they never received.
   */
  async sendRecommendedJobNotification(
    workerId: string,
    jobOfferId: string,
  ): Promise<boolean> {
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
      if (!profile?.phone || !offer) return false;
      if (profile.profile_type !== 'WORKER' || profile.status !== 'ACTIVE')
        return false;

      // No flow arming: the approved template's button opens `/offres/:id`, so
      // the worker applies on the web. This previously both armed the apply flow
      // and — worse — returned without sending when the worker happened to be
      // mid-conversation, silently dropping the recommendation entirely.

      const dateStr = offer.scheduled_at?.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      const tpl = WHATSAPP_TEMPLATES.jobRecommendation;
      return await this.whatsApp.sendTemplateMessage(
        profile.phone,
        'jobRecommendation',
        {
          firstName: profile.first_name,
          title: offer.title,
          amount: formatAmount(
            offer.amount != null ? Number(offer.amount) : null,
            offer.payment_flow,
          ),
          address: jobLocationLabel(offer),
          date: dateStr ?? 'Non précisée',
          // URL suffix for the CTA button (/offres/{{6}}).
          jobOfferId,
        },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send recommended job notification to worker ${workerId}`,
        err,
      );
      return false;
    }
  }
}
