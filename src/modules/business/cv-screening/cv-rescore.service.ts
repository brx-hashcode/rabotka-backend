import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CvScreeningResumeStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { CV_SCREENING_QUEUE } from '../../../common/services/queue/queue.module';
import { QueueService } from '../../../common/services/queue/queue.service';
import { readApplicationAnswers } from './cv-assessment';
import {
  CvGridService,
  jobHash,
  type GridOf,
  type GridOwner,
} from './cv-grid.service';
import { evaluate } from './cv-marking';
import { CvRestoreService } from './cv-restore.service';
import { CV_GRID_RESCORE, type CvGridRescore } from './cv-screening.events';
import {
  CV_READING_RETRY,
  CvScreeningService,
  type CvScreeningJob,
} from './cv-screening.service';

/**
 * « Ré-analyser »: an offer's candidates read again on its grid, without a
 * « CV inclus ». The move from the previous formula is always allowed; after
 * that, `business.cv_rescore_limit` times per offer. A CV the business
 * deleted, or that nothing can rebuild, keeps the score it had.
 */
@Injectable()
export class CvRescoreService {
  private readonly logger = new Logger(CvRescoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly grids: CvGridService,
    private readonly screenings: CvScreeningService,
    private readonly restores: CvRestoreService,
    private readonly queue: QueueService,
    private readonly events: EventEmitter2,
  ) {}

  async start(found: GridOf) {
    await this.grids.requirePlan(found.businessId);
    const before = await this.grids.current(found.owner);
    if (!before) await this.grids.requireOn();
    const rows = await this.grids.rows(found.owner);
    const due = rows.filter((r) => r.gridId !== (before?.id ?? null));
    if (before ? due.length === 0 : rows.length === 0) {
      throw new BadRequestException(
        'Tous les candidats sont déjà notés avec ces critères.',
      );
    }
    // From the previous formula only: that move is not counted.
    const moving = !before || due.every((r) => r.gridId === null);
    if (!moving) await this.take(found.owner);
    const grid =
      before ??
      (await this.grids.create(found.businessId, found.owner, found.job));
    // The CVs are read against the offer as the grid knows it.
    if (found.owner.offerId !== undefined) {
      await this.prisma.cvScreening.updateMany({
        where: { offer_id: found.owner.offerId },
        data: { job_title: found.job.title, job_text: found.job.text },
      });
      if (grid.jobHash !== jobHash(found.job)) {
        await this.prisma.cvGrid.update({
          where: { id: grid.id },
          data: { job_hash: jobHash(found.job) },
        });
      }
    }
    const cvs = rows.filter((r) => r.kind === 'cv' && r.gridId !== grid.id);
    for (const r of cvs) {
      await this.queue
        .addJob<CvScreeningJob>(
          CV_SCREENING_QUEUE,
          { resumeId: r.id, rescore: true },
          CV_READING_RETRY,
        )
        .catch((err: unknown) =>
          this.logger.error(`CV ${r.id} not queued for a new reading`, err),
        );
    }
    const profiles = rows
      .filter((r) => r.kind === 'profile' && r.gridId !== grid.id)
      .map((r) => r.id);
    if (profiles.length > 0) {
      this.events.emit(CV_GRID_RESCORE, {
        applicationIds: profiles,
      } satisfies CvGridRescore);
    }
    return this.grids.view(found);
  }

  /** One of the free re-analyses, atomically. */
  private async take(owner: GridOwner): Promise<void> {
    const { limit, used, counted } = await this.grids.rescores(owner);
    // Profiles only, no CV read yet: nothing to count on, and little to pay.
    if (!counted) return;
    const { count } = await this.prisma.cvScreening.updateMany({
      where: {
        ...(owner.offerId !== undefined
          ? { offer_id: owner.offerId }
          : { id: owner.screeningId }),
        rescores: { lt: limit },
      },
      data: { rescores: { increment: 1 } },
    });
    if (count === 0 || used >= limit) {
      throw new BadRequestException(
        `Les ${limit} ré-analyses de cette offre ont été utilisées. Vous pouvez encore changer l’importance des critères.`,
      );
    }
  }

  /** One CV read again. Its score changes only when the reading succeeds. */
  async process(resumeId: string): Promise<void> {
    const resume = await this.prisma.cvScreeningResume.findUnique({
      where: { id: resumeId },
      include: { screening: true },
    });
    if (
      !resume ||
      resume.status !== CvScreeningResumeStatus.SCORED ||
      resume.removed_at
    ) {
      return;
    }
    const grid = await this.grids.current(
      resume.screening.offer_id
        ? { offerId: resume.screening.offer_id }
        : { screeningId: resume.screening_id },
    );
    if (!grid || grid.id === resume.grid_id) return;
    const text = await this.textOf(resume);
    if (text === null) return;
    const read = await this.screenings.mark(
      grid,
      { title: resume.screening.job_title, text: resume.screening.job_text },
      { kind: 'text', text },
      resume.id,
      readApplicationAnswers(resume.application_answers),
    );
    if (!read?.isCv) {
      // Kept as it was; thrown, so the queue tries again.
      throw new Error(`CV ${resume.id} could not be read again`);
    }
    const e = evaluate(grid.items, read.reading);
    const { count } = await this.prisma.cvScreeningResume.updateMany({
      // Not one deleted, or read again, meanwhile.
      where: { id: resume.id, removed_at: null, grid_id: resume.grid_id },
      data: {
        score: e.score,
        criteria: Prisma.DbNull,
        grid_id: grid.id,
        reading: read.reading,
        musts_missing: e.missing,
        summary: read.summary,
        strengths: read.strengths,
        gaps: read.gaps,
        cv_text: text,
      },
    });
    if (count > 0) await this.screenings.progressed(resume.screening_id);
  }

  private async textOf(
    resume: Prisma.CvScreeningResumeGetPayload<{
      include: { screening: true };
    }>,
  ): Promise<string | null> {
    if (resume.cv_text) return resume.cv_text;
    if (resume.cv_text === '') return null;
    if (!resume.storage_key) return this.restores.restore(resume);
    const source = await this.screenings.sourceOf(resume);
    return source ? this.screenings.transcribe(source, resume.id) : null;
  }
}
