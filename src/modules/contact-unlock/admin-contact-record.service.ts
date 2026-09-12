import { Injectable, NotFoundException } from '@nestjs/common';
import { ContactRecordOrigin, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  AdminCacheService,
  ADMIN_LIST_TTL_SECONDS,
} from '../../common/services/cache/admin-cache.service';
import { AdminListContactRecordsDto } from './dto/admin-list-contact-records.dto';

export type AdminContactRecordListItem = {
  id: string;
  origin: ContactRecordOrigin;
  amount: number;
  unlockedAt: string;
  employerId: string;
  employerName: string;
  employerPhone: string;
  workerId: string;
  workerName: string;
  workerPhone: string;
  /** Null for DIRECT — there is no job behind it. */
  jobOfferId: string | null;
  jobTitle: string | null;
  createdAt: string;
};

export type AdminContactRecordListResult = {
  data: AdminContactRecordListItem[];
  total: number;
  page: number;
  limit: number;
};

const PARTY_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  phone: true,
  email: true,
  avatar_url: true,
  profile_type: true,
} as const;

/**
 * Admin reads over the contact ledger — "who has paid to reach whom".
 *
 * Reads the stored `contact_records` rows rather than re-deriving from payments
 * the way `paid-contacts.sql.ts` has to for historical data. That derivation
 * answers a different question (distinct PAIRS), and the warning in its own
 * header — that two definitions of the same word is a bug in itself — is why
 * this service never reimplements it.
 */
@Injectable()
export class AdminContactRecordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: AdminCacheService,
  ) {}

  async list(
    dto: AdminListContactRecordsDto,
  ): Promise<AdminContactRecordListResult> {
    const params = {
      page: dto.page ?? 1,
      limit: dto.limit ?? 10,
      q: dto.q,
      origin: dto.origin,
      employerId: dto.employer_id,
      workerId: dto.worker_id,
      jobOfferId: dto.job_offer_id,
      since: dto.since?.toISOString(),
      until: dto.until?.toISOString(),
    };

    return this.cache.wrap(
      this.cache.listKey('contact-records', params),
      ADMIN_LIST_TTL_SECONDS,
      () => this.loadList(params),
    );
  }

  private async loadList(params: {
    page: number;
    limit: number;
    q?: string;
    origin?: ContactRecordOrigin[];
    employerId?: string;
    workerId?: string;
    jobOfferId?: string;
    since?: string;
    until?: string;
  }): Promise<AdminContactRecordListResult> {
    const where = this.buildWhere(params);
    const { page, limit } = params;

    const [rows, total] = await Promise.all([
      this.prisma.contactRecord.findMany({
        where,
        orderBy: { unlocked_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          employer: { select: PARTY_SELECT },
          worker: { select: PARTY_SELECT },
          job_offer: { select: { id: true, title: true } },
        },
      }),
      this.prisma.contactRecord.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        origin: r.origin,
        amount: Number(r.amount),
        unlockedAt: r.unlocked_at.toISOString(),
        employerId: r.employer_id,
        employerName: this.fullName(r.employer),
        employerPhone: r.employer.phone,
        workerId: r.worker_id,
        workerName: this.fullName(r.worker),
        workerPhone: r.worker.phone,
        jobOfferId: r.job_offer_id,
        jobTitle: r.job_offer?.title ?? null,
        createdAt: r.created_at.toISOString(),
      })),
      total,
      page,
      limit,
    };
  }

  private buildWhere(params: {
    q?: string;
    origin?: ContactRecordOrigin[];
    employerId?: string;
    workerId?: string;
    jobOfferId?: string;
    since?: string;
    until?: string;
  }): Prisma.ContactRecordWhereInput {
    const where: Prisma.ContactRecordWhereInput = {};

    if (params.origin?.length) where.origin = { in: params.origin };
    if (params.employerId) where.employer_id = params.employerId;
    if (params.workerId) where.worker_id = params.workerId;
    if (params.jobOfferId) where.job_offer_id = params.jobOfferId;

    if (params.since || params.until) {
      where.unlocked_at = {
        ...(params.since && { gte: new Date(params.since) }),
        ...(params.until && { lt: new Date(params.until) }),
      };
    }

    const q = params.q?.trim();
    if (q) {
      // Split so "Marie Employeuse" matches across first_name + last_name, the
      // same way the applications list does — a single `contains` on either
      // column finds nothing for the most natural thing an admin types.
      const parts = q.split(/\s+/).filter(Boolean);
      const nameMatch = (
        profile: 'employer' | 'worker',
      ): Prisma.ContactRecordWhereInput[] =>
        parts.length > 1
          ? [
              {
                [profile]: {
                  first_name: { contains: parts[0], mode: 'insensitive' },
                  last_name: {
                    contains: parts.slice(1).join(' '),
                    mode: 'insensitive',
                  },
                },
              },
            ]
          : [
              {
                [profile]: {
                  first_name: { contains: q, mode: 'insensitive' },
                },
              },
              {
                [profile]: {
                  last_name: { contains: q, mode: 'insensitive' },
                },
              },
            ];

      where.OR = [
        ...nameMatch('employer'),
        ...nameMatch('worker'),
        { job_offer: { title: { contains: q, mode: 'insensitive' } } },
      ];
    }

    return where;
  }

  /**
   * One ledger row in full: both parties, the job if there was one, and the
   * payment trail behind it.
   */
  async detail(id: string) {
    const record = await this.prisma.contactRecord.findUnique({
      where: { id },
      include: {
        employer: { select: PARTY_SELECT },
        worker: { select: PARTY_SELECT },
        job_offer: {
          select: {
            id: true,
            title: true,
            status: true,
            quantity: true,
            scheduled_at: true,
          },
        },
      },
    });

    if (!record) throw new NotFoundException('Contact introuvable');

    // The attempt carries the two-sided payment state a MISSION unlock went
    // through; a DIRECT unlock has none, and the nulls say so honestly.
    const attempt = record.contact_unlock_attempt_id
      ? await this.prisma.contactUnlockAttempt.findUnique({
          where: { id: record.contact_unlock_attempt_id },
          select: {
            id: true,
            status: true,
            employer_paid: true,
            worker_paid: true,
            employer_paid_at: true,
            worker_paid_at: true,
            employer_amount: true,
            worker_amount: true,
            expires_at: true,
            unlocked_at: true,
          },
        })
      : null;

    return {
      id: record.id,
      origin: record.origin,
      amount: Number(record.amount),
      unlockedAt: record.unlocked_at.toISOString(),
      createdAt: record.created_at.toISOString(),
      employer: this.party(record.employer),
      worker: this.party(record.worker),
      jobOffer: record.job_offer
        ? {
            id: record.job_offer.id,
            title: record.job_offer.title,
            status: record.job_offer.status,
            quantity: record.job_offer.quantity,
            scheduledAt: record.job_offer.scheduled_at?.toISOString() ?? null,
          }
        : null,
      applicationId: record.application_id,
      contactUnlockAttemptId: record.contact_unlock_attempt_id,
      paymentId: record.payment_id,
      paymentRequestId: record.payment_request_id,
      unlockAttempt: attempt
        ? {
            id: attempt.id,
            status: attempt.status,
            employerPaid: attempt.employer_paid,
            workerPaid: attempt.worker_paid,
            employerPaidAt: attempt.employer_paid_at?.toISOString() ?? null,
            workerPaidAt: attempt.worker_paid_at?.toISOString() ?? null,
            employerAmount: Number(attempt.employer_amount),
            workerAmount: Number(attempt.worker_amount),
            expiresAt: attempt.expires_at.toISOString(),
            unlockedAt: attempt.unlocked_at?.toISOString() ?? null,
          }
        : null,
    };
  }

  /**
   * The contacts tab on an admin profile page.
   *
   * An EMPLOYER's rows are everyone they paid to reach; a WORKER's are every
   * employer who paid to reach them. Both directions come from the same table,
   * so the tab and the list page cannot drift.
   */
  async forProfile(profileId: string, limit = 50) {
    const [asEmployer, asWorker] = await Promise.all([
      this.prisma.contactRecord.findMany({
        where: { employer_id: profileId },
        orderBy: { unlocked_at: 'desc' },
        take: limit,
        include: {
          worker: { select: PARTY_SELECT },
          job_offer: { select: { id: true, title: true } },
        },
      }),
      this.prisma.contactRecord.findMany({
        where: { worker_id: profileId },
        orderBy: { unlocked_at: 'desc' },
        take: limit,
        include: {
          employer: { select: PARTY_SELECT },
          job_offer: { select: { id: true, title: true } },
        },
      }),
    ]);

    return {
      // Workers this profile paid to reach.
      contacted: asEmployer.map((r) => ({
        id: r.id,
        origin: r.origin,
        amount: Number(r.amount),
        unlockedAt: r.unlocked_at.toISOString(),
        profile: this.party(r.worker),
        jobOfferId: r.job_offer_id,
        jobTitle: r.job_offer?.title ?? null,
      })),
      // Employers who paid to reach this profile.
      contactedBy: asWorker.map((r) => ({
        id: r.id,
        origin: r.origin,
        amount: Number(r.amount),
        unlockedAt: r.unlocked_at.toISOString(),
        profile: this.party(r.employer),
        jobOfferId: r.job_offer_id,
        jobTitle: r.job_offer?.title ?? null,
      })),
      totals: {
        contacted: asEmployer.length,
        contactedBy: asWorker.length,
        // What this employer has spent reaching people. Summed from the rows
        // above, so it is bounded by `limit` — the list endpoint is the source
        // of truth for a full-history figure.
        spent: asEmployer.reduce((sum, r) => sum + Number(r.amount), 0),
      },
    };
  }

  private party(p: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    email: string | null;
    avatar_url: string | null;
    profile_type: string;
  }) {
    return {
      id: p.id,
      name: this.fullName(p),
      phone: p.phone,
      email: p.email,
      avatarUrl: p.avatar_url,
      profileType: p.profile_type,
    };
  }

  private fullName(p: { first_name: string; last_name: string }): string {
    return `${p.first_name} ${p.last_name}`.trim() || '—';
  }
}
