import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ApplicationStatus,
  ExternalApplicationStatus,
  JobOfferStatus,
} from '@prisma/client';

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
        is_partner: true,
        partner_rank: true,
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
      /** Shown in « Ils recrutent avec Rabotka »; staff's call only. */
      partner: b.is_partner,
      partnerRank: b.partner_rank,
    };
  }

  /** Makes it a partner or not, and its place among partners. */
  async setPartner(
    profileId: string,
    input: { partner: boolean; rank?: number | null },
  ) {
    const b = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
      select: { id: true },
    });
    if (!b) throw new NotFoundException('Not a business profile.');
    await this.prisma.business.update({
      where: { id: b.id },
      data: {
        is_partner: input.partner,
        partner_rank: input.partner ? (input.rank ?? null) : null,
      },
    });
    return this.careersOf(profileId);
  }

  async mailboxesOf(profileId: string) {
    // The business view already carries no token: address, dates, state.
    const { mailboxes } = await this.mailboxes.list(profileId);
    return mailboxes;
  }

  // ── At a glance ──────────────────────────────────────────────────────

  /**
   * Does this business need us? Its plan, what is stuck (candidates waiting,
   * offers ending with nobody retained, invitations never accepted, a
   * mailbox to reconnect, papers to review), its last activity and the main
   * figures of the last 30 days.
   */
  async health(profileId: string) {
    const now = new Date();
    const day = 86_400_000;
    const twoDaysAgo = new Date(now.getTime() - 2 * day);
    const weekAgo = new Date(now.getTime() - 7 * day);
    const inAWeek = new Date(now.getTime() + 7 * day);
    const monthAgo = new Date(now.getTime() - 30 * day);
    const business = await this.prisma.business.findUnique({
      where: { profile_id: profileId },
      select: { id: true, verification_status: true },
    });
    if (!business) throw new NotFoundException('Not a business profile.');
    const offerOf = { employer_id: profileId, deleted_at: null };
    const hired = [
      ApplicationStatus.ACCEPTED,
      ApplicationStatus.STARTED,
      ApplicationStatus.END,
    ];

    const [
      plan,
      waitingRabotka,
      waitingDirect,
      endingOffers,
      staleInvites,
      expiredMailboxes,
      papersToReview,
      lastActivity,
      openOffers,
      candidates,
      directCandidates,
      hires,
      directHires,
      team,
    ] = await Promise.all([
      this.subscriptions.entitlements(business.id),
      this.prisma.application.count({
        where: {
          job_offer: offerOf,
          deleted_at: null,
          status: { in: [ApplicationStatus.PENDING, ApplicationStatus.VIEWED] },
          created_at: { lt: twoDaysAgo },
        },
      }),
      this.prisma.externalApplication.count({
        where: {
          job_offer: offerOf,
          status: ExternalApplicationStatus.PENDING,
          created_at: { lt: twoDaysAgo },
        },
      }),
      this.prisma.jobOffer.findMany({
        where: {
          ...offerOf,
          status: JobOfferStatus.ACTIVE,
          scheduled_at: { gte: now, lte: inAWeek },
          applications: { none: { status: { in: hired } } },
          external_applications: {
            none: { status: ExternalApplicationStatus.RETAINED },
          },
        },
        select: { id: true, title: true, scheduled_at: true },
        orderBy: { scheduled_at: 'asc' },
        take: 10,
      }),
      this.prisma.businessMember.findMany({
        where: {
          business_id: business.id,
          status: 'INVITED',
          invited_at: { lt: weekAgo },
        },
        select: { id: true, name: true, email: true, invited_at: true },
      }),
      this.prisma.businessMailbox.findMany({
        where: { business_id: business.id, expired_at: { not: null } },
        select: { id: true, email: true },
      }),
      this.prisma.businessDocument.count({
        where: {
          business_id: business.id,
          verification_status: 'PENDING',
          superseded_at: null,
        },
      }),
      this.prisma.businessActivity.findFirst({
        where: { business_id: business.id },
        orderBy: { created_at: 'desc' },
        select: {
          created_at: true,
          action: true,
          member: { select: { name: true } },
        },
      }),
      this.prisma.jobOffer.count({
        where: {
          ...offerOf,
          status: {
            in: [JobOfferStatus.ACTIVE, JobOfferStatus.PARTIALLY_FILLED],
          },
        },
      }),
      this.prisma.application.count({
        where: {
          job_offer: offerOf,
          deleted_at: null,
          created_at: { gte: monthAgo },
        },
      }),
      this.prisma.externalApplication.count({
        where: { job_offer: offerOf, created_at: { gte: monthAgo } },
      }),
      this.prisma.application.count({
        where: {
          job_offer: offerOf,
          deleted_at: null,
          status: { in: hired },
          accepted_at: { gte: monthAgo },
        },
      }),
      this.prisma.externalApplication.count({
        where: {
          job_offer: offerOf,
          status: ExternalApplicationStatus.RETAINED,
          retained_at: { gte: monthAgo },
        },
      }),
      this.prisma.businessMember.count({
        where: {
          business_id: business.id,
          status: { in: ['INVITED', 'ACTIVE'] },
        },
      }),
    ]);

    const alerts: {
      kind: string;
      count: number;
      items?: { id: string; label: string; at?: string | null }[];
    }[] = [];
    if (business.verification_status !== 'VERIFIED') {
      alerts.push({
        kind: `VERIFICATION_${business.verification_status}`,
        count: 1,
      });
    }
    if (!plan.plan) alerts.push({ kind: 'NO_PLAN', count: 1 });
    else if (
      plan.endsAt &&
      new Date(plan.endsAt) <= inAWeek &&
      plan.status !== 'EXPIRED' &&
      plan.status !== 'CANCELLED'
    ) {
      alerts.push({
        kind: plan.status === 'TRIAL' ? 'TRIAL_ENDING' : 'PLAN_ENDING',
        count: 1,
      });
    }
    if (waitingRabotka + waitingDirect > 0) {
      alerts.push({
        kind: 'CANDIDATES_WAITING',
        count: waitingRabotka + waitingDirect,
      });
    }
    if (endingOffers.length > 0) {
      alerts.push({
        kind: 'OFFERS_ENDING_UNFILLED',
        count: endingOffers.length,
        items: endingOffers.map((o) => ({
          id: o.id,
          label: o.title,
          at: o.scheduled_at?.toISOString() ?? null,
        })),
      });
    }
    if (staleInvites.length > 0) {
      alerts.push({
        kind: 'INVITES_PENDING',
        count: staleInvites.length,
        items: staleInvites.map((m) => ({
          id: m.id,
          label: `${m.name} <${m.email}>`,
          at: m.invited_at?.toISOString() ?? null,
        })),
      });
    }
    if (expiredMailboxes.length > 0) {
      alerts.push({
        kind: 'MAILBOX_EXPIRED',
        count: expiredMailboxes.length,
        items: expiredMailboxes.map((b) => ({ id: b.id, label: b.email })),
      });
    }
    if (papersToReview > 0) {
      alerts.push({ kind: 'PAPERS_TO_REVIEW', count: papersToReview });
    }

    return {
      plan: {
        name: plan.plan?.name ?? null,
        status: plan.status,
        endsAt: plan.endsAt,
      },
      lastActivity: lastActivity
        ? {
            at: lastActivity.created_at.toISOString(),
            action: lastActivity.action,
            by: lastActivity.member?.name ?? null,
          }
        : null,
      alerts,
      last30Days: {
        candidates: candidates + directCandidates,
        hires: hires + directHires,
      },
      openOffers,
      teamSize: team,
    };
  }

  // ── Interviews and CV analyses ───────────────────────────────────────

  /** The business's interviews, newest first, with the candidate's answer. */
  async interviews(profileId: string) {
    const businessId = await this.businessId(profileId);
    const rows = await this.prisma.interview.findMany({
      where: { business_id: businessId },
      orderBy: { starts_at: 'desc' },
      take: 200,
      select: {
        id: true,
        created_at: true,
        starts_at: true,
        duration_minutes: true,
        mode: true,
        location: true,
        status: true,
        responded_at: true,
        response_note: true,
        job_title: true,
        candidate_name: true,
        candidate_email: true,
        offer_id: true,
        application_id: true,
        cv_resume_id: true,
      },
    });
    return rows.map((i) => ({
      id: i.id,
      createdAt: i.created_at.toISOString(),
      startsAt: i.starts_at.toISOString(),
      durationMinutes: i.duration_minutes,
      mode: i.mode,
      location: i.location,
      status: i.status,
      respondedAt: i.responded_at?.toISOString() ?? null,
      responseNote: i.response_note,
      jobTitle: i.job_title,
      candidateName: i.candidate_name,
      candidateEmail: i.candidate_email,
      offerId: i.offer_id,
      applicationId: i.application_id,
      // From a careers page or an uploaded CV rather than a Rabotka profile.
      fromCv: i.cv_resume_id !== null,
    }));
  }

  /** The business's CV analyses: what was read, and when the files go. */
  async cvScreenings(profileId: string) {
    const businessId = await this.businessId(profileId);
    const rows = await this.prisma.cvScreening.findMany({
      where: { business_id: businessId },
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        id: true,
        created_at: true,
        job_title: true,
        offer_id: true,
        status: true,
        external: true,
        expires_at: true,
        purged_at: true,
        resumes: { select: { status: true } },
      },
    });
    return rows.map((r) => {
      const count = (status: string) =>
        r.resumes.filter((x) => x.status === status).length;
      return {
        id: r.id,
        createdAt: r.created_at.toISOString(),
        jobTitle: r.job_title,
        offerId: r.offer_id,
        status: r.status,
        // An outside candidate's CV read on arrival, not an upload.
        fromCareersPage: r.external,
        cvs: r.resumes.length,
        scored: count('SCORED'),
        unreadable: count('UNREADABLE'),
        failed: count('FAILED'),
        queued: count('QUEUED'),
        expiresAt: r.expires_at.toISOString(),
        purgedAt: r.purged_at?.toISOString() ?? null,
      };
    });
  }

  // ── Admin notes ──────────────────────────────────────────────────────

  async notes(profileId: string) {
    const businessId = await this.businessId(profileId);
    const rows = await this.prisma.adminBusinessNote.findMany({
      where: { business_id: businessId, deleted_at: null },
      orderBy: { created_at: 'desc' },
      include: {
        author: { select: { id: true, first_name: true, last_name: true } },
      },
    });
    return rows.map((n) => ({
      id: n.id,
      body: n.body,
      createdAt: n.created_at.toISOString(),
      edited: n.updated_at.getTime() - n.created_at.getTime() > 1000,
      author: {
        id: n.author.id,
        name: `${n.author.first_name} ${n.author.last_name}`.trim(),
      },
    }));
  }

  async addNote(profileId: string, authorId: string, body: string) {
    const businessId = await this.businessId(profileId);
    await this.prisma.adminBusinessNote.create({
      data: {
        business_id: businessId,
        author_id: authorId,
        body: noteBody(body),
      },
    });
    return this.notes(profileId);
  }

  async editNote(
    profileId: string,
    authorId: string,
    noteId: string,
    body: string,
  ) {
    await this.ownNote(profileId, authorId, noteId);
    await this.prisma.adminBusinessNote.update({
      where: { id: noteId },
      data: { body: noteBody(body) },
    });
    return this.notes(profileId);
  }

  async deleteNote(profileId: string, authorId: string, noteId: string) {
    await this.ownNote(profileId, authorId, noteId);
    await this.prisma.adminBusinessNote.update({
      where: { id: noteId },
      data: { deleted_at: new Date() },
    });
    return this.notes(profileId);
  }

  private async ownNote(profileId: string, authorId: string, noteId: string) {
    const businessId = await this.businessId(profileId);
    const note = await this.prisma.adminBusinessNote.findFirst({
      where: { id: noteId, business_id: businessId, deleted_at: null },
      select: { author_id: true },
    });
    if (!note) throw new NotFoundException('Note not found.');
    if (note.author_id !== authorId) {
      throw new ForbiddenException('Only its author changes a note.');
    }
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

export const MAX_ADMIN_NOTE = 4000;

function noteBody(raw: string): string {
  const body = raw.trim();
  if (!body) throw new BadRequestException('The note is empty.');
  if (body.length > MAX_ADMIN_NOTE) {
    throw new BadRequestException(
      `A note is ${MAX_ADMIN_NOTE} characters at most.`,
    );
  }
  return body;
}
