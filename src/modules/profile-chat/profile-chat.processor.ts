import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MessageModerationStatus } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { MESSAGING_NUDGE_QUEUE } from '../../common/services/queue/queue.module';
import { QueueService } from '../../common/services/queue/queue.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { NotificationDispatcher } from '../notification-dispatch/notification-dispatcher.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { DISCUSSIONS_CTA_PATH } from '../../common/constants/whatsapp-templates';
import type { MessagingNudgeJob } from './profile-chat.nudge';

const TEMPLATE_ENABLED_KEY = 'messaging.nudge_template_enabled';

/**
 * Sends "you have an unread message" — or, for now, mostly counts the times it
 * would have.
 *
 * Runs in the QUEUE WORKER, not the API process.
 *
 * THE MONEY DECISION LIVES HERE. Inside WhatsApp's 24h service window the
 * dispatcher sends free-form and this costs nothing. Outside it, a template is
 * billed per message — so the paid half ships behind
 * `messaging.nudge_template_enabled`, off by default, and every skipped send is
 * logged. That counter is the measurement: it says exactly what turning the
 * switch on would have cost, before anything is spent.
 *
 * The consequence is stated rather than hidden: with the switch off, the ~89%
 * of profiles whose window has never opened get no nudge at all. That is a
 * deliberate deprivation for the length of the measurement, not the intended
 * end state.
 */
@Injectable()
export class ProfileChatProcessor implements OnModuleInit {
  private readonly logger = new Logger(ProfileChatProcessor.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly prisma: PrismaService,
    private readonly config: SystemConfigService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly whatsApp: WhatsAppService,
  ) {}

  onModuleInit(): void {
    this.queueService.createWorker<MessagingNudgeJob>(
      MESSAGING_NUDGE_QUEUE,
      async (job) => {
        await this.handle(job.data);
      },
    );
  }

  private async handle(job: MessagingNudgeJob): Promise<void> {
    const { conversationId, recipientId } = job;

    // Re-checked at FIRE TIME rather than cancelled on read. QueueService has
    // no removal API, and re-checking is sturdier anyway: it also covers the
    // case where somebody opens the thread while this job is already running.
    const unread = await this.prisma.profileMessage.count({
      where: {
        conversation_id: conversationId,
        sender_id: { not: recipientId },
        read_at: null,
        deleted_at: null,
        moderation_status: { not: MessageModerationStatus.HELD },
      },
    });
    if (unread === 0) {
      this.logger.debug(`Nudge skipped for ${recipientId}: nothing unread`);
      return;
    }

    const recipient = await this.prisma.profile.findUnique({
      where: { id: recipientId },
      select: { id: true, first_name: true, phone: true },
    });
    if (!recipient?.phone) return;

    const { open } = await this.whatsApp.isServiceWindowOpen(recipientId);

    if (!open && !(await this.templateEnabled())) {
      // THE MEASUREMENT. One line per nudge that a paid template would have
      // carried, so the decision to switch it on is made against a number
      // rather than an estimate.
      this.logger.log(
        `Nudge suppressed (window closed, template disabled) profile=${recipientId} conversation=${conversationId} unread=${unread}`,
      );
      return;
    }

    // NO MESSAGE CONTENT on either path — not the original, not the redacted
    // form. Text copied into WhatsApp leaves the surface where the moderation
    // means anything, and the count is all a nudge needs to say.
    const body =
      unread === 1
        ? 'Vous avez reçu un nouveau message non lu.'
        : `Vous avez reçu ${unread} nouveaux messages non lus.`;

    try {
      await this.dispatcher.send({
        profileId: recipient.id,
        phone: recipient.phone,
        windowOpen: open,
        freeForm: {
          body: `Bonjour ${recipient.first_name},\n\n${body}\n\nConsultez votre espace pour en prendre connaissance.`,
          buttonText: 'Voir mes messages',
          path: DISCUSSIONS_CTA_PATH,
        },
        template: {
          key: 'newMessageNudge',
          params: recipient.first_name,
        },
        body,
      });
    } catch (error) {
      // A nudge that fails is a nudge not sent. It must not fail the job into
      // BullMQ's retry, which would re-send to everybody it already reached
      // when one recipient's number is bad.
      this.logger.warn(
        `Nudge failed for ${recipientId}: ${(error as Error).message}`,
      );
    }
  }

  private async templateEnabled(): Promise<boolean> {
    return (await this.config.get(TEMPLATE_ENABLED_KEY, 'false')) === 'true';
  }
}
