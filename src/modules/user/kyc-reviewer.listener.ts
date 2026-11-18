import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  AdminNotificationEvent,
  type AdminNotificationPayload,
} from '../../common/events/admin-notification.events';
import { NotificationService } from '../notification/notification.service';
import type { KycReviewKind } from '../mail/templates/kyc-review-requested';

/**
 * Emails the KYC verification group when there is something to review: a
 * person sent their identity documents (at sign-up, or later from the app —
 * possibly after a rejection), or an organisation signed up or resubmitted
 * its papers.
 *
 * No longer on « profile created »: a person may sign up without their
 * documents (NOT_SUBMITTED), and an email about a profile with nothing to
 * review only teaches reviewers to ignore these. Hooked on the admin events
 * rather than called from ProfileService, so neither path knows about it.
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

  @OnEvent(AdminNotificationEvent.PROFILE_KYC_SUBMITTED, { async: true })
  async onDocumentsSubmitted(payload: AdminNotificationPayload): Promise<void> {
    await this.safely(
      payload,
      payload?.metadata?.resubmitted === true ? 'resubmitted' : 'documents',
    );
  }

  @OnEvent(AdminNotificationEvent.ORGANISATION_REVIEW_REQUESTED, {
    async: true,
  })
  async onOrganisationToReview(
    payload: AdminNotificationPayload,
  ): Promise<void> {
    await this.safely(payload, 'organisation');
  }

  private async safely(
    payload: AdminNotificationPayload | undefined,
    kind: KycReviewKind,
  ): Promise<void> {
    if (!payload?.entityId) return;
    try {
      await this.notifyReviewers(payload.entityId, kind);
    } catch (err) {
      this.logger.error(
        `KYC review emails failed for profile=${payload.entityId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  private async notifyReviewers(
    profileId: string,
    kind: KycReviewKind,
  ): Promise<void> {
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
      profileName:
        `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim() ||
        'Profil sans nom',
      profileType: profile.profile_type,
      city: profile.city,
      reviewUrl: `${base}/profiles/${profileId}`,
      kind,
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
