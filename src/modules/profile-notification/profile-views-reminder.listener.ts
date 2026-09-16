import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AccountStatus, ProfileType } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { IdempotencyService } from '../../common/services/idempotency/idempotency.service';
import { NOTIFICATIONS_CTA_PATH } from '../../common/constants/whatsapp-templates';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { WhatsAppLoginLinkService } from '../auth/whatsapp-login-link.service';
import {
  PROFILE_VIEWS_THRESHOLD_EVENT,
  profileViewsReminderKey,
  type ProfileViewsThresholdPayload,
} from './profile-notification.events';

/**
 * Sends the "your profile is getting views" WhatsApp reminder.
 *
 * The cooldown was claimed by the emitter. This hands it back whenever nothing
 * reached the worker — ineligible, no phone, provider refused (including the
 * template not being approved yet) — so the next view can try again instead of
 * the worker being muted for a week over a message they never got.
 */
@Injectable()
export class ProfileViewsReminderListener {
  private readonly logger = new Logger(ProfileViewsReminderListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly whatsApp: WhatsAppService,
    private readonly loginLink: WhatsAppLoginLinkService,
  ) {}

  @OnEvent(PROFILE_VIEWS_THRESHOLD_EVENT)
  async handle(payload: ProfileViewsThresholdPayload): Promise<void> {
    const sent = await this.send(payload).catch((err: unknown) => {
      this.logger.warn(
        `Profile views reminder failed for worker ${payload.workerId}`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    });

    if (!sent) {
      await this.idempotency
        .release(profileViewsReminderKey(payload.workerId))
        .catch(() => undefined);
    }
  }

  private async send({
    workerId,
    unreadCount,
  }: ProfileViewsThresholdPayload): Promise<boolean> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: workerId },
      select: {
        phone: true,
        first_name: true,
        status: true,
        profile_type: true,
        deleted_at: true,
      },
    });
    const phone = profile?.phone?.trim();
    if (
      !profile ||
      !phone ||
      profile.profile_type !== ProfileType.WORKER ||
      profile.status !== AccountStatus.ACTIVE ||
      profile.deleted_at
    ) {
      return false;
    }

    // Minted here: `sendTemplateMessage` never touches the outbound queue, so
    // nothing else fills the button's code. Null falls back to the bare path.
    const loginCode = await this.loginLink
      .mint(workerId, NOTIFICATIONS_CTA_PATH)
      .catch(() => null);

    return this.whatsApp.sendTemplateMessage(
      phone,
      'profileViewsDigest',
      { firstName: profile.first_name, count: unreadCount, loginCode },
      workerId,
    );
  }
}
