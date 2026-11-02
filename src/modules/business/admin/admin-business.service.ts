import { Injectable, NotFoundException } from '@nestjs/common';
import { JobOfferStatus } from '@prisma/client';

import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { businessDashboardUrl } from '../../mail/audience';
import { BusinessStatsService } from '../business-stats.service';
import type { StatsPeriod } from '../business-stats';
import { CareersPageService } from '../careers/careers-page.service';
import { MailboxService } from '../mailbox/mailbox.service';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import { TeamService } from '../team/team.service';

/**
 * A business as Rabotka's team sees it in rabotka-admin: what it works with
 * (team, activity, figures, plan usage, careers page, mailboxes) and the
 * support fixes. The business-side services are reused as they are — they
 * all take the business's profile id, the admin page's own.
 */
@Injectable()
export class AdminBusinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: BusinessStatsService,
    private readonly subscriptions: BusinessSubscriptionService,
    private readonly team: TeamService,
    private readonly careers: CareersPageService,
    private readonly mailboxes: MailboxService,
  ) {}

  async businessId(profileId: string): Promise<string> {
    const b = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
      select: { id: true },
    });
    if (!b) throw new NotFoundException('Not a business profile.');
    return b.id;
  }

  overview(profileId: string, days: StatsPeriod) {
    return this.stats.stats(profileId, days);
  }

  async usage(profileId: string) {
    return this.subscriptions.entitlements(await this.businessId(profileId));
  }

  async teamOf(profileId: string) {
    return this.team.listForAdmin(await this.businessId(profileId));
  }

  async activity(
    profileId: string,
    opts: { page?: number; memberId?: string },
  ) {
    return this.team.activity(
      { businessId: await this.businessId(profileId) },
      opts,
    );
  }

  async careersOf(profileId: string) {
    const b = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
      select: {
        public_slug: true,
        distribute_offers: true,
        cover_url: true,
        photos: true,
        benefits: true,
        verification_status: true,
      },
    });
    if (!b) throw new NotFoundException('Not a business profile.');
    const openOffers = await this.prisma.jobOffer.count({
      where: {
        employer_id: profileId,
        deleted_at: null,
        status: {
          in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
        },
      },
    });
    const origin = businessDashboardUrl().replace(/\/espace$/, '');
    return {
      slug: b.public_slug,
      url: b.public_slug ? `${origin}/carrieres/${b.public_slug}` : null,
      // Reachable once verified; listed on Google only with distribution on.
      live: b.verification_status === 'VERIFIED' && !!b.public_slug,
      distributeOffers: b.distribute_offers,
      coverUrl: b.cover_url,
      photos: b.photos,
      benefits: b.benefits,
      openOffers,
    };
  }

  async mailboxesOf(profileId: string) {
    // The business view already carries no token: address, dates, state.
    const { mailboxes } = await this.mailboxes.list(profileId);
    return mailboxes;
  }

  // ── Support actions ──────────────────────────────────────────────────

  async resendInvite(profileId: string, memberId: string) {
    return this.team.resendByAdmin(await this.businessId(profileId), memberId);
  }

  async removeMember(profileId: string, memberId: string) {
    return this.team.removeByAdmin(await this.businessId(profileId), memberId);
  }

  disconnectMailbox(profileId: string, mailboxId: string) {
    return this.mailboxes.disconnect(profileId, mailboxId);
  }

  async removePhoto(profileId: string, index: number) {
    await this.careers.removePhoto(profileId, index);
    return this.careersOf(profileId);
  }

  async removeCover(profileId: string) {
    await this.careers.setCover(profileId, null);
    return this.careersOf(profileId);
  }

  async setDistribution(profileId: string, on: boolean) {
    await this.businessId(profileId);
    await this.prisma.business.update({
      where: { profile_id: profileId },
      data: { distribute_offers: on },
    });
    return this.careersOf(profileId);
  }
}
