import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
  Inject,
} from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { deletedAtFilter } from '../../common/utils/soft-delete.util';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { isWorkerHardBlocked } from '../penalty/penalty.utils';
import { MailService } from '../mail/mail.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { WalletService } from '../wallet/wallet.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MIN_HOURS_FROM_NOW } from './job-offer.constants';
import { AdminNotificationEvent } from '../../common/events/admin-notification.events';
import { BotNotificationService } from '../bot/services/bot-notification.service';
import { MatchingService } from '../matching/matching.service';
import { GeocodingService } from '../../common/services/geocoding/geocoding.service';
import type { Coordinates } from '../../common/services/geocoding/geocoding.service';
import {
  haversineKm,
  proximityScore,
  urgencyScore,
} from '../../common/services/geocoding/geo.utils';
import { CreateJobOfferDto } from './dto/create-job-offer.dto';
import { AdminUpdateJobOfferDto } from './dto/admin-update-job-offer.dto';
import {
  generateJobReference,
  isValidReferenceShape,
  normalizeJobReference,
} from './utils/job-reference.util';
import {
  AccountStatus,
  ApplicationStatus,
  JobOfferStatus,
  PaymentFlow,
  Prisma,
  RejectionSource,
} from '@prisma/client';

const REFERENCE_MAX_ATTEMPTS = 5;

/**
 * Offer statuses that close a posting for good. When an offer moves into one of
 * these, any applicants still waiting on it (PENDING / VIEWED / WAITING_PAYMENT)
 * can no longer be accepted and must be rejected + notified.
 */
const TERMINAL_JOB_OFFER_STATUSES: JobOfferStatus[] = [
  JobOfferStatus.CANCELLED,
  JobOfferStatus.COMPLETED,
  JobOfferStatus.EXPIRED,
];

/**
 * Statuses from which an employer may delete their own offer: it is either still
 * open (ACTIVE) or dead (EXPIRED) — never engaged (filled / in progress /
 * completed). The no-candidate / no-assignment guard is enforced on top.
 */
const EMPLOYER_DELETABLE_JOB_OFFER_STATUSES: JobOfferStatus[] = [
  JobOfferStatus.ACTIVE,
  JobOfferStatus.EXPIRED,
];

/**
 * Keyset cursor for the open-slots feed. Carries every column the query orders
 * by, so paging can resume at an exact position instead of guessing from an id.
 */
type OpenSlotsCursor = {
  scheduledAt: Date;
  createdAt: Date;
  id: string;
};

function encodeOpenSlotsCursor(row: {
  scheduled_at: Date;
  created_at: Date;
  id: string;
}): string {
  const raw = `${row.scheduled_at.toISOString()}|${row.created_at.toISOString()}|${row.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Returns null for anything unparseable — including the old id-only cursors,
 * which have no meaning under keyset paging. A bad cursor restarts from the
 * first page rather than throwing at a user mid-scroll.
 */
function decodeOpenSlotsCursor(cursor?: string): OpenSlotsCursor | null {
  if (!cursor) return null;
  try {
    const [scheduledAt, createdAt, id] = Buffer.from(cursor, 'base64url')
      .toString('utf8')
      .split('|');
    if (!scheduledAt || !createdAt || !id) return null;
    const scheduled = new Date(scheduledAt);
    const created = new Date(createdAt);
    if (Number.isNaN(scheduled.getTime()) || Number.isNaN(created.getTime())) {
      return null;
    }
    return { scheduledAt: scheduled, createdAt: created, id };
  } catch {
    return null;
  }
}
const TITLE_MIN = 5;
const TITLE_MAX = 100;
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 1000;
const AMOUNT_MIN_FCFA = 1000;
const AMOUNT_MAX_FCFA = 1_000_000;
const ADDRESS_MIN = 10;
const NOTE_MAX = 500;
const QUANTITY_MIN = 1;
const QUANTITY_MAX = 100;

export type AdminJobOfferListItem = {
  id: string;
  reference: string;
  title: string;
  category: { id: string; name: string } | null;
  description: string;
  scheduledAt: string;
  amount: number;
  paymentFlow: PaymentFlow | null;
  address: string;
  note: string | null;
  quantity: number;
  status: string;
  employerName: string;
  employerEmail: string;
  employerPhone: string;
  employerAvatarUrl: string | null;
  employerId: string;
  applicationsCount: number;
  createdAt: string;
  updatedAt: string;
  vectorIndexedAt: string | null;
};

export type AdminJobOfferApplicationItem = {
  id: string;
  workerName: string;
  workerEmail: string;
  workerPhone: string;
  workerAvatarUrl: string | null;
  workerId: string;
  status: string;
  penaltyApplied: boolean;
  penaltyAmount: number | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
};

export type AdminJobOfferDetailResponse = AdminJobOfferListItem & {
  applications: AdminJobOfferApplicationItem[];
};

export type JobOfferListItem = {
  id: string;
  reference: string;
  title: string;
  description: string;
  scheduled_at: Date;
  amount: number | null;
  payment_flow: PaymentFlow | null;
  address: string;
  note: string | null;
  quantity: number;
  acceptedCount: number;
  status: string;
  employer_id: string;
  created_at: Date;
};

export type JobOfferDetail = JobOfferListItem & {
  employer?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    reliability_score: number | null;
    avatar_url: string | null;
    rating_avg: number | null;
    rating_count: number;
  };
};

@Injectable()
export class JobOfferService {
  private readonly logger = new Logger(JobOfferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly systemConfigService: SystemConfigService,
    private readonly walletService: WalletService,
    private readonly botNotification: BotNotificationService,
    private readonly eventEmitter: EventEmitter2,
    private readonly matchingService: MatchingService,
    private readonly geocodingService: GeocodingService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  private notificationCooldownKey(workerId: string): string {
    return `job_notif_cooldown:${workerId}`;
  }

  async create(
    employerId: string,
    dto: CreateJobOfferDto,
  ): Promise<JobOfferListItem> {
    const employer = await this.prisma.profile.findUnique({
      where: { id: employerId },
      select: {
        id: true,
        status: true,
        profile_type: true,
        reliability_score: true,
      },
    });
    if (!employer) {
      throw new NotFoundException('Employeur introuvable');
    }
    if (employer.status !== AccountStatus.ACTIVE) {
      throw new ForbiddenException(
        'Le profil doit être actif pour publier des offres',
      );
    }
    if (employer.profile_type !== 'EMPLOYER') {
      throw new ForbiddenException(
        "Seuls les employeurs peuvent publier des offres d'emploi",
      );
    }

    const fees = await this.systemConfigService.getFees();
    const employerScore = employer.reliability_score ?? 100;
    if (employerScore <= fees.reliabilityScoreMin) {
      throw new ForbiddenException(
        "Votre compte est pénalisé. Vous ne pouvez pas publier d'offres pour le moment.",
      );
    }

    const hardBlocked = await isWorkerHardBlocked(this.prisma, employerId);
    if (hardBlocked) {
      throw new ForbiddenException(
        '🚨 Votre compte est bloqué en raison de pénalités impayées depuis plus de 3 jours. Tapez PAYER pour régulariser votre situation.',
      );
    }

    this.validateCreateDto(dto);

    const scheduledAt = new Date(dto.scheduled_at);
    const now = new Date();
    const minDate = new Date(
      now.getTime() + MIN_HOURS_FROM_NOW * 60 * 60 * 1000,
    );
    if (scheduledAt < minDate) {
      throw new BadRequestException(
        `La date doit être au moins ${MIN_HOURS_FROM_NOW} heures dans le futur`,
      );
    }

    const baseData = {
      employer_id: employerId,
      title: dto.title.trim(),
      description: dto.description.trim(),
      scheduled_at: scheduledAt,
      amount: dto.amount,
      payment_flow: dto.payment_flow,
      address: dto.address.trim(),
      note: dto.note?.trim() ?? null,
      quantity: dto.quantity ?? 1,
      status: JobOfferStatus.ACTIVE,
      ...(dto.category_id ? { category_id: dto.category_id } : {}),
    };

    let offer: Awaited<ReturnType<typeof this.prisma.jobOffer.create>> | null =
      null;
    for (let attempt = 0; attempt < REFERENCE_MAX_ATTEMPTS; attempt++) {
      try {
        offer = await this.prisma.jobOffer.create({
          data: { ...baseData, reference: generateJobReference() },
        });
        break;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          Array.isArray(err.meta?.target) &&
          (err.meta?.target as string[]).includes('reference')
        ) {
          continue;
        }
        throw err;
      }
    }
    if (!offer) {
      throw new InternalServerErrorException(
        "Impossible de générer une référence unique pour l'offre",
      );
    }

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_CREATED, {
      event: AdminNotificationEvent.JOB_OFFER_CREATED,
      title: 'Nouvelle offre',
      message: `Nouvelle offre d'emploi créée : ${offer.title}`,
      entityType: 'job-offer',
      entityId: String(offer.id),
      timestamp: new Date().toISOString(),
    });

    // Geocode first, then index — matching uses lat/lng so coordinates must be written before indexing.
    this.geocodingService
      .geocode(offer.address)
      .then(async (coords) => {
        if (coords) {
          await this.prisma.jobOffer.update({
            where: { id: offer.id },
            data: { latitude: coords.lat, longitude: coords.lng },
          });
        }
        await this.matchingService.indexJobOffer(offer.id);
      })
      .then(async () => {
        const [enabled, minScore, maxWorkers, cooldownMinutes] =
          await Promise.all([
            this.systemConfigService.isRecommendationEnabled(),
            this.systemConfigService.getMinNotificationScore(),
            this.systemConfigService.getMaxNotificationWorkers(),
            this.systemConfigService.getNotificationCooldownMinutes(),
          ]);
        if (!enabled) return;

        const workerResults: { id: string; score: number }[] =
          await this.matchingService.findMatchingWorkersForJob(
            offer.id,
            maxWorkers,
          );

        // Notify eligible workers with a concurrency cap of 5 to avoid
        // thundering-herd on the WhatsApp queue when a job matches many workers.
        const NOTIFY_CONCURRENCY = 5;
        let active = 0;
        const queue: Promise<void>[] = [];

        const notify = async (workerId: string) => {
          if (cooldownMinutes > 0) {
            const key = this.notificationCooldownKey(workerId);
            const locked = await this.redis.set(
              key,
              '1',
              'EX',
              cooldownMinutes * 60,
              'NX',
            );
            if (locked === null) return;
          }
          await this.botNotification
            .sendRecommendedJobNotification(workerId, offer.id)
            .catch((err: unknown) =>
              this.logger.warn(
                `sendRecommendedJobNotification failed for worker ${workerId}`,
                err instanceof Error ? err.message : String(err),
              ),
            );
        };

        for (const { id: workerId, score } of workerResults) {
          if (score < minScore) continue;
          const p = Promise.resolve().then(async () => {
            while (active >= NOTIFY_CONCURRENCY) {
              await Promise.race(queue);
            }
            active++;
            try {
              await notify(workerId);
            } finally {
              active--;
            }
          });
          queue.push(p);
        }
        await Promise.all(queue);
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `geocode/index/notify failed for offer ${offer.id}`,
          err instanceof Error ? err.message : String(err),
        ),
      );

    return this.toListItem(offer);
  }

  /**
   * Worker-facing offers must still have at least one free slot.
   * Status can lag (e.g. ACTIVE while acceptedCount === quantity); we filter on counts.
   */
  private offerHasOpenSlots(quantity: number, acceptedCount: number): boolean {
    const accepted = Number.isFinite(acceptedCount) ? acceptedCount : 0;
    return accepted < quantity;
  }

  /**
   * Fetches worker's top applied-to category IDs (up to 3), ordered by
   * application count descending. Used to boost category-matched offers.
   */
  async getWorkerTopCategories(workerId: string): Promise<string[]> {
    const rows = await this.prisma.application.groupBy({
      by: ['job_offer_id'],
      where: { worker_id: workerId },
      _count: { job_offer_id: true },
      orderBy: { _count: { job_offer_id: 'desc' } },
      take: 20,
    });
    if (rows.length === 0) return [];

    const offerIds = rows.map((r) => r.job_offer_id);
    const offers = await this.prisma.jobOffer.findMany({
      where: { id: { in: offerIds }, category_id: { not: null } },
      select: { category_id: true },
    });

    const counts = new Map<string, number>();
    for (const o of offers) {
      if (!o.category_id) continue;
      counts.set(o.category_id, (counts.get(o.category_id) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id);
  }

  /**
   * Single-query replacement for the old batch-loop approach.
   * Uses a raw SQL HAVING clause to filter out full offers directly in Postgres,
   * avoiding up to 25 round-trips.
   */
  private async queryOpenSlots(params: {
    take: number;
    cursor?: OpenSlotsCursor | null;
    excludeWorkerId?: string;
    minScheduledAt: Date;
  }): Promise<
    Array<{
      id: string;
      reference: string;
      title: string;
      description: string;
      scheduled_at: Date;
      amount: unknown;
      payment_flow: PaymentFlow | null;
      address: string;
      latitude: number | null;
      longitude: number | null;
      note: string | null;
      quantity: number;
      status: string;
      employer_id: string;
      category_id: string | null;
      created_at: Date;
      accepted_count: bigint;
    }>
  > {
    const { take, cursor, excludeWorkerId, minScheduledAt } = params;

    // Keyset predicate must mirror `ORDER BY scheduled_at ASC, created_at DESC`
    // exactly. It is written out longhand rather than as a row comparison
    // because the directions are mixed — `(a,b,c) > (x,y,z)` only holds when
    // every column sorts the same way. The previous `jo.id > cursor` compared a
    // column the query never ordered by, so paging both skipped and repeated
    // offers regardless of the in-memory re-sort below.
    const keyset = cursor
      ? Prisma.sql`AND (
          jo.scheduled_at > ${cursor.scheduledAt}
          OR (jo.scheduled_at = ${cursor.scheduledAt} AND jo.created_at < ${cursor.createdAt})
          OR (jo.scheduled_at = ${cursor.scheduledAt} AND jo.created_at = ${cursor.createdAt} AND jo.id > ${cursor.id}::uuid)
        )`
      : Prisma.empty;

    // Prisma doesn't support HAVING on aggregates in findMany so we use $queryRaw.
    // Parameters are passed positionally as $1, $2, … to prevent SQL injection.
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        reference: string;
        title: string;
        description: string;
        scheduled_at: Date;
        amount: unknown;
        payment_flow: PaymentFlow | null;
        address: string;
        latitude: number | null;
        longitude: number | null;
        note: string | null;
        quantity: number;
        status: string;
        employer_id: string;
        category_id: string | null;
        created_at: Date;
        accepted_count: bigint;
      }>
    >`
      SELECT
        jo.id,
        jo.reference,
        jo.title,
        jo.description,
        jo.scheduled_at,
        jo.amount,
        jo.payment_flow,
        jo.address,
        jo.latitude,
        jo.longitude,
        jo.note,
        jo.quantity,
        jo.status,
        jo.employer_id,
        jo.category_id,
        jo.created_at,
        COUNT(a.id) FILTER (WHERE a.status = 'ACCEPTED') AS accepted_count
      FROM job_offers jo
      LEFT JOIN applications a ON a.job_offer_id = jo.id
      WHERE
        jo.status IN ('ACTIVE', 'PARTIALLY_FILLED')
        AND jo.scheduled_at > ${minScheduledAt}
        ${keyset}
        ${
          excludeWorkerId
            ? Prisma.sql`AND NOT EXISTS (
                SELECT 1 FROM applications ex
                WHERE ex.job_offer_id = jo.id
                  AND ex.worker_id = ${excludeWorkerId}::uuid
              )`
            : Prisma.empty
        }
      GROUP BY jo.id
      HAVING COUNT(a.id) FILTER (WHERE a.status = 'ACCEPTED') < jo.quantity
      ORDER BY jo.scheduled_at ASC, jo.created_at DESC
      LIMIT ${take}
    `;

    return rows;
  }

  async findActive(
    limit = 20,
    cursor?: string,
    excludeAppliedByWorkerId?: string,
    workerCoords?: Coordinates | null,
    workerCategoryIds?: string[],
  ): Promise<{
    data: JobOfferListItem[];
    nextCursor: string | null;
  }> {
    const targetCount = limit + 1;
    const minScheduledAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

    const rows = await this.queryOpenSlots({
      take: targetCount,
      cursor: decodeOpenSlotsCursor(cursor),
      excludeWorkerId: excludeAppliedByWorkerId,
      minScheduledAt,
    });

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;

    // Derive the cursor from SQL order, BEFORE the display re-sort below.
    // Reading it off the re-sorted array (as this did) yields an arbitrary row's
    // position and breaks the next page.
    const lastInQueryOrder = slice.at(-1);
    const nextCursor =
      hasMore && lastInQueryOrder
        ? encodeOpenSlotsCursor(lastInQueryOrder)
        : null;

    // Rank the page for display: proximity (when coords are known) + urgency +
    // category affinity. This is per-page, not global — the page is chosen by
    // `scheduled_at` and only then reordered. Global ranking needs the
    // recommendation engine, which doesn't cursor-paginate.
    const categorySet = new Set(workerCategoryIds ?? []);
    const ordered =
      workerCoords || categorySet.size > 0 ? [...slice] : slice;
    if (ordered !== slice) {
      ordered.sort((a, b) => {
        const scoreOf = (o: (typeof rows)[number]): number => {
          const prox =
            workerCoords && o.latitude != null && o.longitude != null
              ? proximityScore(
                  haversineKm(workerCoords, {
                    lat: o.latitude,
                    lng: o.longitude,
                  }),
                )
              : 0.5;
          const urgency = urgencyScore(o.scheduled_at);
          const category =
            o.category_id && categorySet.has(o.category_id) ? 1.0 : 0.0;
          return 0.45 * prox + 0.3 * urgency + 0.25 * category;
        };
        return scoreOf(b) - scoreOf(a);
      });
    }

    const data = ordered.map((o) =>
      this.toListItem(o, Number(o.accepted_count)),
    );

    return { data, nextCursor };
  }

  async findById(id: string): Promise<JobOfferDetail | null> {
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id, deleted_at: null },
      include: {
        employer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            reliability_score: true,
            avatar_url: true,
            rating_avg: true,
            rating_count: true,
          },
        },
        _count: {
          select: {
            applications: { where: { status: 'ACCEPTED' } },
          },
        },
      },
    });
    if (!offer) return null;

    return {
      ...this.toListItem(offer, offer._count.applications),
      employer: offer.employer
        ? {
            id: offer.employer.id,
            first_name: offer.employer.first_name,
            last_name: offer.employer.last_name,
            phone: offer.employer.phone,
            reliability_score: offer.employer.reliability_score,
            avatar_url: offer.employer.avatar_url,
            rating_avg: offer.employer.rating_avg,
            rating_count: offer.employer.rating_count,
          }
        : undefined,
    };
  }

  async findByReference(ref: string): Promise<JobOfferDetail | null> {
    const normalized = normalizeJobReference(ref);
    if (!isValidReferenceShape(normalized)) return null;
    const offer = await this.prisma.jobOffer.findUnique({
      where: { reference: normalized },
      include: {
        employer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            reliability_score: true,
            avatar_url: true,
            rating_avg: true,
            rating_count: true,
          },
        },
        _count: {
          select: {
            applications: { where: { status: 'ACCEPTED' } },
          },
        },
      },
    });
    if (!offer) return null;

    return {
      ...this.toListItem(offer, offer._count.applications),
      employer: offer.employer
        ? {
            id: offer.employer.id,
            first_name: offer.employer.first_name,
            last_name: offer.employer.last_name,
            phone: offer.employer.phone,
            reliability_score: offer.employer.reliability_score,
            avatar_url: offer.employer.avatar_url,
            rating_avg: offer.employer.rating_avg,
            rating_count: offer.employer.rating_count,
          }
        : undefined,
    };
  }

  async findByEmployerId(employerId: string): Promise<JobOfferListItem[]>;
  async findByEmployerId(
    employerId: string,
    pagination: {
      page: number;
      pageSize: number;
      /** Narrow to these statuses. Must be applied here, not client-side: a
       *  post-pagination filter yields short pages and a wrong `total`. */
      statuses?: JobOfferStatus[];
    },
  ): Promise<{ items: JobOfferListItem[]; total: number }>;
  async findByEmployerId(
    employerId: string,
    pagination?: {
      page: number;
      pageSize: number;
      statuses?: JobOfferStatus[];
    },
  ): Promise<
    JobOfferListItem[] | { items: JobOfferListItem[]; total: number }
  > {
    // Newest first, and count ACCEPTED applications so the "N/M postes" filled
    // count is accurate (matches findById/findByReference).
    const acceptedCount = {
      _count: {
        select: {
          applications: { where: { status: ApplicationStatus.ACCEPTED } },
        },
      },
    } as const;

    // Hide soft-deleted offers from the employer's own list.
    const where: Prisma.JobOfferWhereInput = {
      employer_id: employerId,
      deleted_at: null,
      ...(pagination?.statuses?.length
        ? { status: { in: pagination.statuses } }
        : {}),
    };

    if (!pagination) {
      const offers = await this.prisma.jobOffer.findMany({
        where,
        orderBy: { created_at: 'desc' },
        include: acceptedCount,
      });
      return offers.map((o) => this.toListItem(o, o._count.applications));
    }

    const { page, pageSize } = pagination;
    const skip = page * pageSize;
    const [offers, total] = await Promise.all([
      this.prisma.jobOffer.findMany({
        where,
        orderBy: { created_at: 'desc' },
        include: acceptedCount,
        skip,
        take: pageSize,
      }),
      this.prisma.jobOffer.count({ where }),
    ]);
    return {
      items: offers.map((o) => this.toListItem(o, o._count.applications)),
      total,
    };
  }

  /**
   * When an offer is moved to a terminal status, reject the applicants still
   * waiting on it (PENDING / VIEWED / WAITING_PAYMENT → REJECTED) and WhatsApp
   * each worker. No-op for non-terminal statuses. Idempotent — REJECTED is
   * terminal, so re-running rejects nothing.
   */
  private async closeApplicantsIfTerminal(
    jobOfferId: string,
    status: JobOfferStatus,
  ): Promise<void> {
    if (!TERMINAL_JOB_OFFER_STATUSES.includes(status)) return;

    const leftovers = await this.prisma.application.findMany({
      where: {
        job_offer_id: jobOfferId,
        status: {
          in: [
            ApplicationStatus.PENDING,
            ApplicationStatus.VIEWED,
            ApplicationStatus.WAITING_PAYMENT,
          ],
        },
      },
      select: { id: true },
    });
    if (leftovers.length === 0) return;

    const ids = leftovers.map((a) => a.id);
    await this.prisma.application.updateMany({
      where: { id: { in: ids } },
      data: {
        status: ApplicationStatus.REJECTED,
        rejected_at: new Date(),
        // Offer closed, not an employer decision — see RejectionSource.
        rejection_source: RejectionSource.AUTO_FILL,
      },
    });
    for (const appId of ids) {
      this.botNotification
        .sendApplicationRejectedToWorker(appId)
        .catch((err: unknown) =>
          this.logger.warn(
            `[closeApplicantsIfTerminal] notify failed for ${appId}:`,
            err,
          ),
        );
    }
  }

  async updateStatus(
    id: string,
    status: JobOfferStatus,
    actorProfileId: string,
  ): Promise<JobOfferListItem> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }
    if (offer.employer_id !== actorProfileId) {
      throw new ForbiddenException('Non autorisé à modifier cette offre');
    }

    const updated = await this.prisma.jobOffer.update({
      where: { id },
      data: { status },
    });

    await this.closeApplicantsIfTerminal(id, status);

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_STATUS_CHANGED, {
      event: AdminNotificationEvent.JOB_OFFER_STATUS_CHANGED,
      title: 'Statut offre modifié',
      message: `Le statut de l'offre "${updated.title}" a été changé en ${status}`,
      entityType: 'job-offer',
      entityId: String(updated.id),
      timestamp: new Date().toISOString(),
    });

    return this.toListItem(updated);
  }

  /**
   * Reopens an expired offer at a new date.
   *
   * Previously this existed only inside the WhatsApp republish flow, so an
   * employer who ignored the expiry message had no way to reopen the offer at
   * all. The flow now delegates here so both channels share one implementation.
   *
   * The bot flow got ownership and status correctness implicitly — it only ever
   * walks a queue it built from that employer's own expired offers. A REST
   * caller supplies an arbitrary id, so both are checked explicitly.
   */
  async republish(
    id: string,
    actorProfileId: string,
    scheduledAt: Date,
  ): Promise<JobOfferListItem> {
    const offer = await this.prisma.jobOffer.findUnique({ where: { id } });
    if (!offer || offer.deleted_at) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }
    if (offer.employer_id !== actorProfileId) {
      throw new ForbiddenException('Non autorisé à modifier cette offre');
    }
    if (offer.status !== JobOfferStatus.EXPIRED) {
      throw new BadRequestException(
        'Seule une offre expirée peut être republiée',
      );
    }
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Date invalide');
    }

    const minDate = new Date(Date.now() + MIN_HOURS_FROM_NOW * 60 * 60 * 1000);
    if (scheduledAt < minDate) {
      throw new BadRequestException(
        `La date doit être au moins ${MIN_HOURS_FROM_NOW} heures dans le futur`,
      );
    }

    const updated = await this.prisma.jobOffer.update({
      where: { id },
      data: { scheduled_at: scheduledAt, status: JobOfferStatus.ACTIVE },
    });

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_STATUS_CHANGED, {
      event: AdminNotificationEvent.JOB_OFFER_STATUS_CHANGED,
      title: 'Offre republiée',
      message: `L'offre "${updated.title}" a été republiée`,
      entityType: 'job-offer',
      entityId: String(updated.id),
      timestamp: new Date().toISOString(),
    });

    return this.toListItem(updated);
  }

  async updateStatusByAdmin(
    id: string,
    status: JobOfferStatus,
  ): Promise<JobOfferListItem> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }

    const updated = await this.prisma.jobOffer.update({
      where: { id },
      data: { status },
    });

    await this.closeApplicantsIfTerminal(id, status);

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_STATUS_CHANGED, {
      event: AdminNotificationEvent.JOB_OFFER_STATUS_CHANGED,
      title: 'Statut offre modifié',
      message: `Le statut de l'offre "${updated.title}" a été changé en ${status}`,
      entityType: 'job-offer',
      entityId: String(updated.id),
      timestamp: new Date().toISOString(),
    });

    return this.toListItem(updated);
  }

  validateCreateDto(dto: CreateJobOfferDto): void {
    if (
      !dto.title ||
      dto.title.trim().length < TITLE_MIN ||
      dto.title.trim().length > TITLE_MAX
    ) {
      throw new BadRequestException(
        `Le titre doit contenir entre ${TITLE_MIN} et ${TITLE_MAX} caractères`,
      );
    }
    if (
      !dto.description ||
      dto.description.trim().length < DESCRIPTION_MIN ||
      dto.description.trim().length > DESCRIPTION_MAX
    ) {
      throw new BadRequestException(
        `La description doit contenir entre ${DESCRIPTION_MIN} et ${DESCRIPTION_MAX} caractères`,
      );
    }
    const scheduledAt = new Date(dto.scheduled_at);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Format de date invalide');
    }
    if (
      dto.amount != null &&
      (dto.amount < AMOUNT_MIN_FCFA || dto.amount > AMOUNT_MAX_FCFA)
    ) {
      throw new BadRequestException(
        `Le montant doit être entre ${AMOUNT_MIN_FCFA} et ${AMOUNT_MAX_FCFA} FCFA`,
      );
    }
    if (!dto.address || dto.address.trim().length < ADDRESS_MIN) {
      throw new BadRequestException(
        `L'adresse doit contenir au moins ${ADDRESS_MIN} caractères`,
      );
    }
    if (dto.note != null && dto.note.length > NOTE_MAX) {
      throw new BadRequestException(
        `La note ne peut pas dépasser ${NOTE_MAX} caractères`,
      );
    }
    if (
      dto.quantity != null &&
      (!Number.isInteger(dto.quantity) ||
        dto.quantity < QUANTITY_MIN ||
        dto.quantity > QUANTITY_MAX)
    ) {
      throw new BadRequestException(
        `Le nombre de personnes doit être entre ${QUANTITY_MIN} et ${QUANTITY_MAX}`,
      );
    }
  }

  async getJobOffersForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    status?: JobOfferStatus[];
    deleted?: boolean;
  }): Promise<{
    data: AdminJobOfferListItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit, q, status, deleted } = params;
    const skip = (page - 1) * limit;

    // Active rows by default; the admin "Deleted" filter flips to archived rows.
    const where: Prisma.JobOfferWhereInput = {
      deleted_at: deletedAtFilter(deleted),
    };

    const searchTrimmed = q?.trim() ?? '';
    if (searchTrimmed.length > 0) {
      where.OR = [
        { title: { contains: searchTrimmed, mode: 'insensitive' } },
        { description: { contains: searchTrimmed, mode: 'insensitive' } },
        { address: { contains: searchTrimmed, mode: 'insensitive' } },
      ];
    }

    if (status != null && status.length > 0) {
      where.status = { in: status };
    }

    const [offers, total] = await Promise.all([
      this.prisma.jobOffer.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          category: {
            select: {
              id: true,
              name: true,
            },
          },
          employer: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
              phone: true,
              avatar_url: true,
            },
          },
          _count: {
            select: { applications: true },
          },
        },
      }),
      this.prisma.jobOffer.count({ where }),
    ]);

    const data: AdminJobOfferListItem[] = offers.map((o) => ({
      id: o.id,
      reference: o.reference,
      title: o.title,
      category:
        o.category == null
          ? null
          : { id: o.category.id, name: o.category.name },
      description: o.description,
      scheduledAt: o.scheduled_at.toISOString(),
      amount: Number(o.amount),
      paymentFlow: o.payment_flow,
      address: o.address,
      note: o.note,
      quantity: o.quantity,
      status: o.status,
      employerName:
        `${o.employer.first_name ?? ''} ${o.employer.last_name ?? ''}`.trim() ||
        '—',
      employerEmail: o.employer.email,
      employerPhone: o.employer.phone,
      employerAvatarUrl: o.employer.avatar_url ?? null,
      employerId: o.employer_id,
      applicationsCount: o._count.applications,
      createdAt: o.created_at.toISOString(),
      updatedAt: o.updated_at.toISOString(),
      vectorIndexedAt: o.vector_indexed_at?.toISOString() ?? null,
    }));

    return { data, total, page, limit };
  }

  async getJobOfferDetailForAdmin(
    id: string,
  ): Promise<AdminJobOfferDetailResponse> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
      include: {
        category: {
          select: {
            id: true,
            name: true,
          },
        },
        employer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            email: true,
            phone: true,
            avatar_url: true,
          },
        },
        applications: {
          orderBy: { created_at: 'desc' },
          include: {
            worker: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                email: true,
                phone: true,
                avatar_url: true,
              },
            },
          },
        },
        _count: {
          select: { applications: true },
        },
      },
    });

    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }

    return {
      id: offer.id,
      reference: offer.reference,
      title: offer.title,
      category:
        offer.category == null
          ? null
          : { id: offer.category.id, name: offer.category.name },
      description: offer.description,
      scheduledAt: offer.scheduled_at.toISOString(),
      amount: Number(offer.amount),
      paymentFlow: offer.payment_flow,
      address: offer.address,
      note: offer.note,
      quantity: offer.quantity,
      status: offer.status,
      employerName:
        `${offer.employer.first_name ?? ''} ${offer.employer.last_name ?? ''}`.trim() ||
        '—',
      employerEmail: offer.employer.email,
      employerPhone: offer.employer.phone,
      employerAvatarUrl: offer.employer.avatar_url ?? null,
      employerId: offer.employer_id,
      applicationsCount: offer._count.applications,
      createdAt: offer.created_at.toISOString(),
      updatedAt: offer.updated_at.toISOString(),
      vectorIndexedAt: offer.vector_indexed_at?.toISOString() ?? null,
      applications: offer.applications.map((a) => ({
        id: a.id,
        workerName:
          `${a.worker.first_name ?? ''} ${a.worker.last_name ?? ''}`.trim() ||
          '—',
        workerEmail: a.worker.email,
        workerPhone: a.worker.phone,
        workerAvatarUrl: a.worker.avatar_url ?? null,
        workerId: a.worker_id,
        status: a.status,
        penaltyApplied: a.penalty_applied,
        penaltyAmount:
          a.penalty_amount == null ? null : Number(a.penalty_amount),
        cancelledAt: a.cancelled_at?.toISOString() ?? null,
        cancellationReason: a.cancellation_reason,
        createdAt: a.created_at.toISOString(),
      })),
    };
  }

  async deleteJobOfferByAdmin(id: string): Promise<void> {
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, title: true },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }

    // Soft delete (archive) — reversible, preserves history.
    await this.prisma.jobOffer.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    // Remove from vector index — fire-and-forget, non-fatal
    void this.matchingService
      .deleteJobFromIndex(id)
      .catch((err) =>
        this.logger.error(
          `Failed to remove job offer ${id} from vector index after deletion`,
          err,
        ),
      );

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_DELETED, {
      event: AdminNotificationEvent.JOB_OFFER_DELETED,
      title: 'Offre supprimée',
      message: `L'offre d'emploi "${offer.title}" a été supprimée`,
      entityType: 'job-offer',
      entityId: String(id),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Employer-facing delete. An employer may remove one of their own offers only
   * while it carries no engagement: ACTIVE or EXPIRED status, no live applications
   * (candidates) and no assignments. This keeps started / filled / completed
   * offers intact. Soft delete (reversible, preserves history) mirroring
   * {@link deleteJobOfferByAdmin}.
   */
  async deleteByEmployer(id: string, actorProfileId: string): Promise<void> {
    const offer = await this.prisma.jobOffer.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, employer_id: true, status: true },
    });
    if (!offer) {
      throw new NotFoundException('Offre introuvable');
    }
    if (offer.employer_id !== actorProfileId) {
      throw new ForbiddenException("Vous n'êtes pas l'employeur de cette offre");
    }
    if (!EMPLOYER_DELETABLE_JOB_OFFER_STATUSES.includes(offer.status)) {
      throw new BadRequestException(
        'Cette offre ne peut plus être supprimée car elle est en cours ou terminée.',
      );
    }

    const [liveApplications, assignments] = await Promise.all([
      this.prisma.application.count({
        where: {
          job_offer_id: id,
          deleted_at: null,
          status: {
            notIn: [ApplicationStatus.REJECTED, ApplicationStatus.CANCELLED],
          },
        },
      }),
      this.prisma.assignment.count({ where: { job_offer_id: id } }),
    ]);
    if (liveApplications > 0 || assignments > 0) {
      throw new BadRequestException(
        'Impossible de supprimer : cette offre a déjà des candidats.',
      );
    }

    await this.prisma.jobOffer.update({
      where: { id },
      data: { deleted_at: new Date() },
    });

    // Remove from vector index — fire-and-forget, non-fatal
    void this.matchingService
      .deleteJobFromIndex(id)
      .catch((err) =>
        this.logger.error(
          `Failed to remove job offer ${id} from vector index after deletion`,
          err,
        ),
      );
  }

  /** Archive many offers at once (admin bulk delete). Returns the count archived. */
  async bulkSoftDeleteByAdmin(ids: string[]): Promise<{ count: number }> {
    if (ids.length === 0) return { count: 0 };
    const { count } = await this.prisma.jobOffer.updateMany({
      where: { id: { in: ids }, deleted_at: null },
      data: { deleted_at: new Date() },
    });
    // Remove each from the vector index so archived offers stop being matched.
    for (const id of ids) {
      void this.matchingService
        .deleteJobFromIndex(id)
        .catch(() => undefined);
    }
    return { count };
  }

  async updateJobOfferByAdmin(
    id: string,
    dto: AdminUpdateJobOfferDto,
  ): Promise<AdminJobOfferDetailResponse> {
    const offer = await this.prisma.jobOffer.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!offer) {
      throw new NotFoundException("Offre d'emploi introuvable");
    }
    if (offer.status !== JobOfferStatus.ACTIVE) {
      throw new BadRequestException('Only active job offers can be edited');
    }

    const data: Prisma.JobOfferUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined)
      data.description = dto.description.trim();
    if (dto.scheduledAt !== undefined)
      data.scheduled_at = new Date(dto.scheduledAt);
    if (dto.amount !== undefined) data.amount = dto.amount ?? null;
    if (dto.paymentFlow !== undefined)
      data.payment_flow = dto.paymentFlow ?? null;
    if (dto.categoryId !== undefined) {
      if (dto.categoryId === null) {
        data.category = { disconnect: true };
      } else {
        data.category = { connect: { id: dto.categoryId } };
      }
    }
    if (dto.address !== undefined) data.address = dto.address.trim();
    if (dto.note !== undefined) data.note = dto.note.trim() || null;
    if (dto.quantity !== undefined) data.quantity = dto.quantity;

    const updatedOffer = await this.prisma.jobOffer.update({
      where: { id },
      data,
      select: { title: true },
    });

    this.eventEmitter.emit(AdminNotificationEvent.JOB_OFFER_UPDATED, {
      event: AdminNotificationEvent.JOB_OFFER_UPDATED,
      title: 'Offre mise à jour',
      message: `L'offre d'emploi "${updatedOffer.title}" a été mise à jour par un admin`,
      entityType: 'job-offer',
      entityId: String(id),
      timestamp: new Date().toISOString(),
    });

    return this.getJobOfferDetailForAdmin(id);
  }

  private toListItem(
    offer: {
      id: string;
      reference: string;
      title: string;
      description: string;
      scheduled_at: Date;
      amount: unknown;
      payment_flow: PaymentFlow | null;
      address: string;
      note: string | null;
      quantity: number;
      status: string;
      employer_id: string;
      created_at: Date;
    },
    acceptedCount = 0,
  ): JobOfferListItem {
    return {
      id: offer.id,
      reference: offer.reference,
      title: offer.title,
      description: offer.description,
      scheduled_at: offer.scheduled_at,
      amount: offer.amount == null ? null : Number(offer.amount),
      payment_flow: offer.payment_flow,
      address: offer.address,
      note: offer.note,
      quantity: offer.quantity,
      acceptedCount,
      status: offer.status,
      employer_id: offer.employer_id,
      created_at: offer.created_at,
    };
  }
}
