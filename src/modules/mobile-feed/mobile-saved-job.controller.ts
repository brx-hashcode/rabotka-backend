import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  InteractionActor,
  InteractionKind,
  InteractionObject,
  InteractionSource,
  ProfileType,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JobOfferService } from '../job-offer/job-offer.service';
import { InteractionEventService } from '../recommendation-engine/interaction-event.service';
import { toWorkerJobShape } from './worker-job-shape';

/**
 * Worker bookmarks ("save a job for later"). Save/unsave a job offer and list the
 * saved ones (hydrated like the job feed, with saved=true + applied flag).
 */
@ApiTags('Mobile — Saved jobs')
@ApiBearerAuth()
@Controller('profile/saved-jobs')
@UseGuards(ProfileAuthGuard)
export class MobileSavedJobController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobOfferService: JobOfferService,
    private readonly interactionEvents: InteractionEventService,
  ) {}

  @Post(':jobOfferId')
  @ApiOperation({ summary: '[Mobile/WORKER] Bookmark a job offer' })
  @ApiResponse({ status: 201, description: 'Saved' })
  async save(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('jobOfferId') jobOfferId: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);

    const offer = await this.prisma.jobOffer.findFirst({
      where: { id: jobOfferId, deleted_at: null },
      select: { id: true, category_id: true, employer_id: true },
    });
    if (!offer) {
      throw new NotFoundException('Offre introuvable');
    }
    // Idempotent — saving an already-saved job is a no-op.
    await this.prisma.savedJob.upsert({
      where: {
        profile_id_job_offer_id: {
          profile_id: profileId,
          job_offer_id: jobOfferId,
        },
      },
      create: { profile_id: profileId, job_offer_id: jobOfferId },
      update: {},
    });

    // Bookmarking is a strong intent signal — second only to applying. It was
    // never recorded before, despite a `save` weight existing since day one.
    void this.interactionEvents.record({
      actorId: profileId,
      actorType: InteractionActor.WORKER,
      kind: InteractionKind.SAVE,
      objectType: InteractionObject.JOB_OFFER,
      objectId: jobOfferId,
      categoryId: offer.category_id,
      counterpartyId: offer.employer_id,
      source: InteractionSource.SERVER,
      surface: 'saved_jobs',
    });

    return { success: true };
  }

  @Delete(':jobOfferId')
  @ApiOperation({ summary: '[Mobile/WORKER] Remove a bookmark' })
  @ApiResponse({ status: 200, description: 'Unsaved' })
  async unsave(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('jobOfferId') jobOfferId: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);
    const removed = await this.prisma.savedJob.deleteMany({
      where: { profile_id: profileId, job_offer_id: jobOfferId },
    });

    // Un-saving is a soft negative: the worker looked again and changed their
    // mind. Only recorded when a bookmark actually existed, so repeated DELETEs
    // don't stack up phantom negatives. Also the only trace of an unsave — the
    // SavedJob row itself is hard-deleted.
    if (removed.count > 0) {
      const offer = await this.prisma.jobOffer.findUnique({
        where: { id: jobOfferId },
        select: { category_id: true, employer_id: true },
      });
      void this.interactionEvents.record({
        actorId: profileId,
        actorType: InteractionActor.WORKER,
        kind: InteractionKind.UNSAVE,
        objectType: InteractionObject.JOB_OFFER,
        objectId: jobOfferId,
        categoryId: offer?.category_id ?? null,
        counterpartyId: offer?.employer_id ?? null,
        source: InteractionSource.SERVER,
        surface: 'saved_jobs',
      });
    }

    return { success: true };
  }

  @Get()
  @ApiOperation({ summary: '[Mobile/WORKER] My bookmarked job offers' })
  @ApiResponse({ status: 200, description: 'Saved job offers' })
  async list(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertWorker(profileId);

    const take = this.parseInt(pageSize, 20, 100);
    const pageNum = this.parseInt(page, 0, 10_000);

    const [rows, total] = await Promise.all([
      this.prisma.savedJob.findMany({
        where: { profile_id: profileId, job_offer: { deleted_at: null } },
        orderBy: { created_at: 'desc' },
        skip: pageNum * take,
        take,
        select: { job_offer_id: true },
      }),
      this.prisma.savedJob.count({
        where: { profile_id: profileId, job_offer: { deleted_at: null } },
      }),
    ]);

    const ids = rows.map((r) => r.job_offer_id);
    const offers = (
      await Promise.all(ids.map((id) => this.jobOfferService.findById(id)))
    ).filter((o): o is NonNullable<typeof o> => o !== null);

    const applied = ids.length
      ? await this.prisma.application.findMany({
          where: { worker_id: profileId, job_offer_id: { in: ids } },
          select: { job_offer_id: true },
        })
      : [];
    const appliedSet = new Set(applied.map((a) => a.job_offer_id));

    // findById returns the service's snake_case shape; the worker app expects
    // isRemote/employmentType/countryName in camelCase, which a bare spread
    // does not give it.
    const items = offers.map((o) => ({
      ...toWorkerJobShape(o),
      matchScore: 0,
      saved: true,
      applied: appliedSet.has(o.id),
    }));
    return { items, total };
  }

  private parseInt(value: string | undefined, fallback: number, max: number) {
    const n = Number.parseInt(value ?? '', 10);
    if (Number.isNaN(n) || n < 0) return fallback;
    return Math.min(n, max);
  }

  private async assertWorker(profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { profile_type: true },
    });
    if (!profile) {
      throw new ForbiddenException('Profil introuvable');
    }
    if (profile.profile_type !== ProfileType.WORKER) {
      throw new ForbiddenException('Réservé aux travailleurs');
    }
  }
}
