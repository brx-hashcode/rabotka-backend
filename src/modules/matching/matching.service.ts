import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QdrantService } from '../qdrant/qdrant.service';
import { SystemConfigService } from '../system-config/system-config.service';

const COLLECTION_WORKERS = 'workers';
const COLLECTION_JOBS = 'jobs';

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
      await this.qdrant.upsertHybrid(COLLECTION_WORKERS, profileId, text, {
        profileId,
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
        category: { select: { name: true, description: true } },
      },
    });

    if (!job) return;

    try {
      await this.qdrant.ensureCollection(COLLECTION_JOBS);
      const text = this.buildJobText(job);
      await this.qdrant.upsertHybrid(COLLECTION_JOBS, jobOfferId, text, {
        jobOfferId,
      });
      this.logger.log(`Indexed job offer ${jobOfferId}`);
    } catch (err) {
      this.logger.error(`Failed to index job offer ${jobOfferId}`, err);
    }
  }

  /**
   * Find top N workers matching a job offer. Returns profile IDs.
   * Falls back to empty array if disabled or error.
   */
  async findMatchingWorkersForJob(
    jobOfferId: string,
    topN = 20,
  ): Promise<string[]> {
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
      return results
        .map((r) => r.payload?.['profileId'] as string)
        .filter(Boolean);
    } catch (err) {
      this.logger.error(
        `findMatchingWorkersForJob failed for ${jobOfferId}`,
        err,
      );
      return [];
    }
  }

  /**
   * Find top N job offers matching a worker profile. Returns job offer IDs.
   * Falls back to empty array if disabled or error.
   */
  async findMatchingJobsForWorker(
    profileId: string,
    topN = 10,
  ): Promise<string[]> {
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
      return results
        .map((r) => r.payload?.['jobOfferId'] as string)
        .filter(Boolean);
    } catch (err) {
      this.logger.error(
        `findMatchingJobsForWorker failed for ${profileId}`,
        err,
      );
      return [];
    }
  }

  /**
   * Find top N worker profiles matching an employer profile (for employer recommendations).
   */
  async findMatchingWorkersForEmployer(
    jobOfferId: string,
    topN = 10,
  ): Promise<string[]> {
    return this.findMatchingWorkersForJob(jobOfferId, topN);
  }
}
