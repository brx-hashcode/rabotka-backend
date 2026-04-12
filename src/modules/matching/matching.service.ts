import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { SystemConfigService } from '../system-config/system-config.service';

const COLLECTION_WORKERS = 'workers';
const COLLECTION_JOBS = 'jobs';
const COLLECTION_EMPLOYERS = 'employers';

function qdrantPayloadString(
  payload: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const v = payload?.[key];
  return typeof v === 'string' ? v : undefined;
}

function mapSearchHitsToScoredIds(
  results: Array<{
    id: string | number;
    score: number;
    payload: Record<string, unknown> | null;
  }>,
  payloadKey: string,
): { id: string; score: number }[] {
  const out: { id: string; score: number }[] = [];
  for (const r of results) {
    const id = qdrantPayloadString(r.payload, payloadKey);
    if (id !== undefined) out.push({ id, score: r.score });
  }
  return out;
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly qdrant: QdrantService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  /**
   * Build embedding text for a worker profile.
   */
  private buildWorkerText(profile: {
    first_name: string;
    last_name: string;
    description: string | null;
    address: string | null;
    category?: { name: string; description: string | null } | null;
  }): string {
    const parts: string[] = [
      `${profile.first_name} ${profile.last_name}`.trim(),
    ];
    if (profile.category?.name) parts.push(profile.category.name);
    if (profile.category?.description) parts.push(profile.category.description);
    if (profile.description) parts.push(profile.description);
    if (profile.address) parts.push(profile.address);
    return parts.join('. ');
  }

  /**
   * Build embedding text for a job offer.
   */
  private buildJobText(job: {
    title: string;
    description: string;
    address: string;
    category?: { name: string; description: string | null } | null;
  }): string {
    const parts: string[] = [job.title, job.description, job.address];
    if (job.category?.name) parts.push(job.category.name);
    if (job.category?.description) parts.push(job.category.description);
    return parts.join('. ');
  }

  /**
   * Embed and upsert a worker profile into Qdrant (gated by feature flag).
   */
  async indexWorkerProfile(profileId: string): Promise<void> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) return;

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        description: true,
        address: true,
        profile_type: true,
        category: { select: { name: true, description: true } },
      },
    });

    if (profile?.profile_type !== 'WORKER') return;

    try {
      await this.qdrant.ensureCollection(COLLECTION_WORKERS);
      const text = this.buildWorkerText(profile);
      const fullName =
        `${profile.first_name} ${profile.last_name}`.trim() || profileId;
      await this.qdrant.upsertHybrid(COLLECTION_WORKERS, profileId, text, {
        profileId,
        firstName: profile.first_name,
        lastName: profile.last_name,
        fullName,
        description: profile.description ?? '',
        address: profile.address ?? '',
        categoryName: profile.category?.name ?? '',
        categoryDescription: profile.category?.description ?? '',
        profileType: profile.profile_type,
      });
      this.logger.log(`Indexed worker profile ${profileId}`);
    } catch (err) {
      this.logger.error(`Failed to index worker profile ${profileId}`, err);
    }
  }

  /**
   * Embed and upsert a job offer into Qdrant (gated by feature flag).
   */
  async indexJobOffer(jobOfferId: string): Promise<void> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) return;

    const job = await this.prisma.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: {
        id: true,
        title: true,
        description: true,
        address: true,
        amount: true,
        note: true,
        category: { select: { name: true, description: true } },
      },
    });

    if (!job) return;

    try {
      await this.qdrant.ensureCollection(COLLECTION_JOBS);
      const text = this.buildJobText(job);
      await this.qdrant.upsertHybrid(COLLECTION_JOBS, jobOfferId, text, {
        jobOfferId: job.id,
        title: job.title,
        description: job.description,
        address: job.address,
        amount: job.amount.toString(),
        note: job.note ?? '',
        categoryName: job.category?.name ?? '',
        categoryDescription: job.category?.description ?? '',
      });
      this.logger.log(`Indexed job offer ${jobOfferId}`);
    } catch (err) {
      this.logger.error(`Failed to index job offer ${jobOfferId}`, err);
    }
  }

  /**
   * Find top N workers matching a job offer. Returns { id, score }[] ordered by score.
   * Falls back to empty array if disabled or error.
   */
  async findMatchingWorkersForJob(
    jobOfferId: string,
    topN = 20,
  ): Promise<{ id: string; score: number }[]> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) return [];

    const job = await this.prisma.jobOffer.findUnique({
      where: { id: jobOfferId },
      select: {
        id: true,
        title: true,
        description: true,
        address: true,
        category: { select: { name: true, description: true } },
      },
    });
    if (!job) return [];

    try {
      await this.qdrant.ensureCollection(COLLECTION_WORKERS);
      const text = this.buildJobText(job);
      const results = await this.qdrant.searchHybrid(
        COLLECTION_WORKERS,
        text,
        topN,
      );
      return mapSearchHitsToScoredIds(results, 'profileId');
    } catch (err) {
      this.logger.error(
        `findMatchingWorkersForJob failed for ${jobOfferId}`,
        err,
      );
      return [];
    }
  }

  /**
   * Find top N job offers matching a worker profile. Returns { id, score }[] ordered by score.
   * Falls back to empty array if disabled or error.
   */
  async findMatchingJobsForWorker(
    profileId: string,
    topN = 10,
  ): Promise<{ id: string; score: number }[]> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) return [];

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        description: true,
        address: true,
        profile_type: true,
        category: { select: { name: true, description: true } },
      },
    });
    if (profile?.profile_type !== 'WORKER') return [];

    try {
      await this.qdrant.ensureCollection(COLLECTION_JOBS);
      const text = this.buildWorkerText(profile);
      const results = await this.qdrant.searchHybrid(
        COLLECTION_JOBS,
        text,
        topN,
      );
      return mapSearchHitsToScoredIds(results, 'jobOfferId');
    } catch (err) {
      this.logger.error(
        `findMatchingJobsForWorker failed for ${profileId}`,
        err,
      );
      return [];
    }
  }

  /**
   * Find top N worker profiles matching an employer's latest job offer.
   * Used when the employer has published at least one offer.
   */
  async findMatchingWorkersForEmployer(
    jobOfferId: string,
    topN = 10,
  ): Promise<{ id: string; score: number }[]> {
    return this.findMatchingWorkersForJob(jobOfferId, topN);
  }

  // ── Employer profile indexing ───────────────────────────────────────────────

  /**
   * Build embedding text for an employer profile.
   */
  private buildEmployerText(profile: {
    first_name: string;
    last_name: string;
    description: string | null;
    address: string | null;
  }): string {
    const parts: string[] = [
      `${profile.first_name} ${profile.last_name}`.trim(),
    ];
    if (profile.description) parts.push(profile.description);
    if (profile.address) parts.push(profile.address);
    return parts.join('. ');
  }

  /**
   * Embed and upsert an employer profile into the employers collection.
   * Gated by feature flag. Used to find matching workers when no job is published yet.
   */
  async indexEmployerProfile(profileId: string): Promise<void> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) return;

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        description: true,
        address: true,
        profile_type: true,
      },
    });

    if (profile?.profile_type !== 'EMPLOYER') return;

    try {
      await this.qdrant.ensureCollection(COLLECTION_EMPLOYERS);
      const text = this.buildEmployerText(profile);
      await this.qdrant.upsertHybrid(COLLECTION_EMPLOYERS, profileId, text, {
        profileId,
        firstName: profile.first_name,
        lastName: profile.last_name,
        description: profile.description ?? '',
        address: profile.address ?? '',
      });
      this.logger.log(`Indexed employer profile ${profileId}`);
    } catch (err) {
      this.logger.error(`Failed to index employer profile ${profileId}`, err);
    }
  }

  /**
   * Find top N workers matching an employer profile description.
   * Fallback when employer has no published job offers yet.
   */
  async findMatchingWorkersForEmployerProfile(
    employerProfileId: string,
    topN = 10,
  ): Promise<{ id: string; score: number }[]> {
    const enabled = await this.systemConfig.isSimilarityEnabled();
    if (!enabled) return [];

    const profile = await this.prisma.profile.findUnique({
      where: { id: employerProfileId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        description: true,
        address: true,
        profile_type: true,
      },
    });

    if (profile?.profile_type !== 'EMPLOYER') return [];

    try {
      await this.qdrant.ensureCollection(COLLECTION_WORKERS);
      const text = this.buildEmployerText(profile);
      const results = await this.qdrant.searchHybrid(
        COLLECTION_WORKERS,
        text,
        topN,
      );
      return mapSearchHitsToScoredIds(results, 'profileId');
    } catch (err) {
      this.logger.error(
        `findMatchingWorkersForEmployerProfile failed for ${employerProfileId}`,
        err,
      );
      return [];
    }
  }
}
