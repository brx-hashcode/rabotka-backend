import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApplicationStatus, JobOfferStatus, ProfileType } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  notificationDedupeKey,
  notifyProfile,
} from '../profile-notification/profile-notification.events';
import { CONTACTABLE_WORKER } from '../recommendation/contactable-worker';

/** Hired, whatever happened after: a worker the business has worked with. */
const WORKED_WITH: ApplicationStatus[] = [
  ApplicationStatus.ACCEPTED,
  ApplicationStatus.STARTED,
  ApplicationStatus.END,
];

/** An application that still stands: no second invitation to the same offer. */
const LIVE: ApplicationStatus[] = [
  ApplicationStatus.PENDING,
  ApplicationStatus.VIEWED,
  ApplicationStatus.WAITING_PAYMENT,
  ...WORKED_WITH,
];

const OPEN_OFFER: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.PARTIALLY_FILLED,
];

const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 30;
/** One invitation per worker and offer is enough; a month covers any offer's life. */
const INVITE_DEDUPE_SECONDS = 30 * 24 * 3600;

const WORKER_SELECT = {
  first_name: true,
  last_name: true,
  avatar_url: true,
  city: true,
  reliability_score: true,
  rating_avg: true,
  rating_count: true,
  status: true,
  verification_status: true,
  deleted_at: true,
  category: { select: { name: true } },
} as const;

type WorkerRow = {
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  city: string | null;
  reliability_score: number | null;
  rating_avg: number | null;
  rating_count: number;
  status: string;
  verification_status: string;
  deleted_at: Date | null;
  category: { name: string } | null;
};

/** Tags as people type them: trimmed, no doubles (case-blind), a few short ones. */
export function cleanTags(tags: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
    const key = tag.toLocaleLowerCase('fr');
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}

/**
 * A business's talent pool: the workers it keeps (a private note, tags) and
 * those it already worked with, and the invitation to apply to one of its
 * open offers — the way to hire someone again. Nothing here reveals a contact.
 */
@Injectable()
export class BusinessTalentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async list(profileId: string) {
    const [kept, hires] = await Promise.all([
      this.prisma.businessTalent.findMany({
        where: { employer_id: profileId },
        orderBy: { created_at: 'desc' },
        select: {
          worker_id: true,
          note: true,
          tags: true,
          created_at: true,
          worker: { select: WORKER_SELECT },
        },
      }),
      this.prisma.application.findMany({
        where: {
          status: { in: WORKED_WITH },
          deleted_at: null,
          job_offer: { employer_id: profileId },
        },
        orderBy: { accepted_at: 'desc' },
        select: {
          worker_id: true,
          accepted_at: true,
          created_at: true,
          job_offer: { select: { title: true, scheduled_at: true } },
          worker: { select: WORKER_SELECT },
        },
      }),
    ]);

    const history = new Map<
      string,
      { missions: number; lastAt: Date; lastTitle: string; worker: WorkerRow }
    >();
    for (const h of hires) {
      const at = h.job_offer.scheduled_at ?? h.accepted_at ?? h.created_at;
      const seen = history.get(h.worker_id);
      if (!seen) {
        history.set(h.worker_id, {
          missions: 1,
          lastAt: at,
          lastTitle: h.job_offer.title,
          worker: h.worker,
        });
      } else {
        seen.missions++;
        if (at > seen.lastAt) {
          seen.lastAt = at;
          seen.lastTitle = h.job_offer.title;
        }
      }
    }

    const row = (
      workerId: string,
      w: WorkerRow,
      keep: { note: string | null; tags: string[]; savedAt: Date } | null,
    ) => {
      const h = history.get(workerId);
      return {
        workerId,
        firstName: w.first_name,
        lastName: w.last_name,
        avatarUrl: w.avatar_url,
        city: w.city,
        categoryName: w.category?.name ?? null,
        reliabilityScore: w.reliability_score,
        ratingAvg: w.rating_avg,
        ratingCount: w.rating_count,
        /** Still on Rabotka, active and verified: may be invited or reached. */
        available:
          w.status === 'ACTIVE' &&
          w.verification_status === 'VERIFIED' &&
          w.deleted_at === null,
        saved: !!keep,
        note: keep?.note ?? null,
        tags: keep?.tags ?? [],
        savedAt: keep?.savedAt.toISOString() ?? null,
        missionsWithUs: h?.missions ?? 0,
        lastMissionAt: h?.lastAt.toISOString() ?? null,
        lastMissionTitle: h?.lastTitle ?? null,
      };
    };

    const out = kept.map((k) =>
      row(k.worker_id, k.worker, {
        note: k.note,
        tags: k.tags,
        savedAt: k.created_at,
      }),
    );
    const keptIds = new Set(kept.map((k) => k.worker_id));
    const alumni = [...history.entries()]
      .filter(([id]) => !keptIds.has(id))
      .sort(([, a], [, b]) => b.lastAt.getTime() - a.lastAt.getTime())
      .map(([id, h]) => row(id, h.worker, null));
    return [...out, ...alumni];
  }

  /** Keeps a worker (or updates the note and tags of one kept). */
  async save(
    profileId: string,
    workerId: string,
    input: { note?: string | null; tags?: string[] },
  ) {
    const worker = await this.prisma.profile.findFirst({
      where: {
        id: workerId,
        profile_type: ProfileType.WORKER,
        deleted_at: null,
      },
      select: { id: true },
    });
    if (!worker) throw new NotFoundException('Travailleur introuvable');

    const data = {
      ...(input.note !== undefined
        ? { note: input.note?.trim().slice(0, 1000) || null }
        : {}),
      ...(input.tags !== undefined ? { tags: cleanTags(input.tags) } : {}),
    };
    await this.prisma.businessTalent.upsert({
      where: {
        employer_id_worker_id: { employer_id: profileId, worker_id: workerId },
      },
      create: { employer_id: profileId, worker_id: workerId, ...data },
      update: data,
    });
    return { saved: true };
  }

  async remove(profileId: string, workerId: string) {
    await this.prisma.businessTalent.deleteMany({
      where: { employer_id: profileId, worker_id: workerId },
    });
    return { saved: false };
  }

  /**
   * Asks a worker to apply to one of the business's open offers — in their
   * notifications, where applying is one tap. Once per worker and offer.
   */
  async invite(profileId: string, workerId: string, offerId: string) {
    const [offer, worker, business] = await Promise.all([
      this.prisma.jobOffer.findFirst({
        where: { id: offerId, employer_id: profileId, deleted_at: null },
        select: { id: true, title: true, status: true },
      }),
      this.prisma.profile.findFirst({
        where: { id: workerId, ...CONTACTABLE_WORKER },
        select: { id: true },
      }),
      this.prisma.business.findUnique({
        where: { profile_id: profileId },
        select: { name: true },
      }),
    ]);
    if (!offer) throw new NotFoundException('Offre introuvable');
    if (!OPEN_OFFER.includes(offer.status)) {
      throw new BadRequestException(
        'Cette offre ne recrute plus : choisissez une offre en cours.',
      );
    }
    if (!worker) {
      throw new NotFoundException("Ce profil n'est plus actif ou vérifié.");
    }
    const applied = await this.prisma.application.count({
      where: {
        job_offer_id: offerId,
        worker_id: workerId,
        status: { in: LIVE },
        deleted_at: null,
      },
    });
    if (applied > 0) {
      throw new ConflictException(
        'Ce travailleur a déjà postulé à cette offre.',
      );
    }

    notifyProfile(this.events, {
      recipientId: workerId,
      actorId: profileId,
      dedupeKey: notificationDedupeKey('invite', offerId, workerId),
      dedupeTtlSeconds: INVITE_DEDUPE_SECONDS,
      input: {
        type: 'JOB_INVITATION',
        jobOfferId: offer.id,
        jobTitle: offer.title,
        businessName: business?.name ?? 'Un employeur',
      },
    });
    return { invited: true };
  }
}
