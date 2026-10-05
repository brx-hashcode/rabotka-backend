import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  AdminNotificationEvent,
  type AdminNotificationPayload,
} from '../../common/events/admin-notification.events';
import { NotificationService } from '../notification/notification.service';

/**
 * Emails the KYC verification group when a profile is created.
 *
 * Every profile is created with its identity documents, so "profile created"
 * is the moment a KYC starts waiting. Hooked on the admin bell event rather
 * than called from ProfileService, so signup knows nothing about it, and the
 * bell alert still goes to everyone as before.
 *
 * Never throws: an email that cannot go out must not fail a signup that has
 * already been committed.
 */
@Injectable()
export class KycReviewerListener {
  private readonly logger = new Logger(KycReviewerListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notification: NotificationService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent(AdminNotificationEvent.PROFILE_CREATED, { async: true })
  async onProfileCreated(payload: AdminNotificationPayload): Promise<void> {
    try {
      await this.notifyReviewers(payload.entityId);
    } catch (err) {
      this.logger.error(
        `KYC review emails failed for profile=${payload.entityId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private async notifyReviewers(profileId: string): Promise<void> {
    const [profile, reviewers] = await Promise.all([
      this.prisma.profile.findUnique({
        where: { id: profileId },
        select: {
          first_name: true,
          last_name: true,
          profile_type: true,
          city: true,
        },
      }),
      this.prisma.user.findMany({
        where: { kyc_reviewer: true, is_active: true, deleted_at: null },
        select: { email: true, first_name: true },
      }),
    ]);

    if (!profile || reviewers.length === 0) return;

    const base = this.config
      .get<string>('ADMIN_BASE_URL', '')
      .trim()
      .replace(/\/+$/, '');
    const params = {
      profileName: `${profile.first_name} ${profile.last_name}`.trim(),
      profileType: profile.profile_type,
      city: profile.city,
      reviewUrl: `${base}/profiles/${profileId}`,
    };

    // One failed address must not cost the others their email.
    const results = await Promise.allSettled(
      reviewers.map((r) =>
        this.notification.notifyKycReviewRequested(r.email, {
          ...params,
          reviewerFirstName: r.first_name,
        }),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      this.logger.warn(
        `KYC review email: ${failed}/${reviewers.length} not queued for profile=${profileId}`,
      );
    }
  }
}
