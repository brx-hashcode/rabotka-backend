import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  PaymentRequestStatus,
  PaymentRequestType,
  ProfileType,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';

/** How the employer came to hold this worker's contact details. */
export type ContactOrigin = 'RECOMMENDATION' | 'MISSION';

export type ContactedProfile = {
  id: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  description: string;
  address: string;
  categories: string[];
  reliabilityScore: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  portfolioSlug: string | null;
  /** The point of the whole feature: the details the employer paid for. */
  phone: string;
  email: string;
  origin: ContactOrigin;
  unlockedAt: string;
  /** Present for MISSION unlocks — which job brought them together. */
  jobTitle: string | null;
};

const CONTACT_PROFILE_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  avatar_url: true,
  description: true,
  address: true,
  phone: true,
  email: true,
  reliability_score: true,
  rating_avg: true,
  rating_count: true,
  portfolio_slug: true,
  categories: { select: { category: { select: { name: true } } } },
} as const;

/**
 * Everyone an employer has paid to reach.
 *
 * The recommendation path is stateless — it writes no ContactUnlockAttempt, only
 * a wallet transaction or an approved payment request — so "who did I contact?"
 * is reconstructed from those payment rows rather than stored. That reconstruction
 * used to live privately inside the mobile recommendation controller; it is here
 * so the mobile feed, the web page and the collaboration graph all agree on what
 * counts as a contact.
 */
@Injectable()
export class ContactedProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Worker ids this employer unlocked through a recommendation, from the two
   * places the payment lands: wallet debit or approved mobile-money request.
   */
  async listRecommendationContactIds(
    employerId: string,
  ): Promise<Map<string, Date>> {
    const [walletTxns, requests] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where: {
          reference_type: 'recommendation_contact',
          reference_id: { not: null },
          wallet: { profile_id: employerId },
        },
        select: { reference_id: true, created_at: true },
      }),
      this.prisma.paymentRequest.findMany({
        where: {
          profile_id: employerId,
          request_type: PaymentRequestType.RECOMMENDATION_CONTACT,
          status: PaymentRequestStatus.APPROVED,
          recommendation_worker_id: { not: null },
        },
        select: { recommendation_worker_id: true, updated_at: true },
      }),
    ]);

    // Keep the earliest payment per worker: that is when the employer actually
    // gained the contact, whatever they paid for afterwards.
    const unlockedAt = new Map<string, Date>();
    const keepEarliest = (id: string, at: Date) => {
      const seen = unlockedAt.get(id);
      if (!seen || at < seen) unlockedAt.set(id, at);
    };

    for (const t of walletTxns) {
      if (t.reference_id) keepEarliest(t.reference_id, t.created_at);
    }
    for (const r of requests) {
      if (r.recommendation_worker_id) {
        keepEarliest(r.recommendation_worker_id, r.updated_at);
      }
    }

    return unlockedAt;
  }

  /** Ids only — what the recommendation feed needs to hide already-paid workers. */
  async listContactedWorkerIds(employerId: string): Promise<Set<string>> {
    return new Set(
      (await this.listRecommendationContactIds(employerId)).keys(),
    );
  }

  /**
   * The full list an employer sees, both origins merged. Phone and email are
   * returned only for pairs this employer paid for — that check is this method,
   * so callers must never widen the id set they pass on.
   */
  async listContacts(employerId: string): Promise<ContactedProfile[]> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: employerId },
      select: { profile_type: true },
    });

    if (profile?.profile_type !== ProfileType.EMPLOYER) {
      throw new ForbiddenException('Réservé aux recruteurs');
    }

    const [recommendationUnlocks, missionUnlocks] = await Promise.all([
      this.listRecommendationContactIds(employerId),
      this.prisma.contactUnlockAttempt.findMany({
        where: { employer_id: employerId, unlocked_at: { not: null } },
        select: {
          worker_id: true,
          unlocked_at: true,
          job_offer: { select: { title: true } },
        },
        orderBy: { unlocked_at: 'desc' },
      }),
    ]);

    const workerIds = new Set<string>([
      ...recommendationUnlocks.keys(),
      ...missionUnlocks.map((u) => u.worker_id),
    ]);
    if (workerIds.size === 0) return [];

    const profiles = await this.prisma.profile.findMany({
      where: { id: { in: [...workerIds] } },
      select: CONTACT_PROFILE_SELECT,
    });

    // A worker reached through a mission is the richer story (there is a job to
    // name), so that origin wins when both exist for the same pair.
    const missionByWorker = new Map(missionUnlocks.map((u) => [u.worker_id, u]));

    const contacts = profiles.map((p): ContactedProfile => {
      const mission = missionByWorker.get(p.id);
      const unlockedAt =
        mission?.unlocked_at ?? recommendationUnlocks.get(p.id) ?? new Date(0);

      return {
        id: p.id,
        firstName: p.first_name,
        lastName: p.last_name,
        avatarUrl: p.avatar_url,
        description: p.description,
        address: p.address,
        categories: p.categories.map((c) => c.category.name),
        reliabilityScore: p.reliability_score,
        ratingAvg: p.rating_avg,
        ratingCount: p.rating_count,
        portfolioSlug: p.portfolio_slug,
        phone: p.phone,
        email: p.email,
        origin: mission ? 'MISSION' : 'RECOMMENDATION',
        unlockedAt: unlockedAt.toISOString(),
        jobTitle: mission?.job_offer?.title ?? null,
      };
    });

    return contacts.sort((a, b) => b.unlockedAt.localeCompare(a.unlockedAt));
  }
}
