import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ProfileType } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JobOfferService } from '../job-offer/job-offer.service';
import { ApplicationService } from '../application/application.service';
import { MatchingService } from '../matching/matching.service';

/**
 * Profile-facing (mobile) read endpoints. Thin role-gated wrappers over the
 * existing job-offer / application / matching services that were previously only
 * reachable via admin controllers or the WhatsApp bot.
 */
@ApiTags('Mobile — Feed')
@ApiBearerAuth()
@Controller('profile')
@UseGuards(ProfileAuthGuard)
export class MobileFeedController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobOfferService: JobOfferService,
    private readonly applicationService: ApplicationService,
    private readonly matchingService: MatchingService,
  ) {}

  @Get('job-feed')
  @ApiOperation({
    summary: '[Mobile/WORKER] Matched job offers',
    description: 'Returns job offers matched to the authenticated worker.',
  })
  @ApiResponse({ status: 200, description: 'Matched job offers' })
  @ApiResponse({ status: 403, description: 'Not a WORKER profile' })
  async jobFeed(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('limit') limit?: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.WORKER);

    const topN = this.parseInt(limit, 10, 50);
    const hits = await this.matchingService.findMatchingJobsForWorker(
      profileId,
      topN,
    );

    // Hydrate the matched ids into full offers, preserving match order.
    const offers = await Promise.all(
      hits.map((hit) => this.jobOfferService.findById(hit.id)),
    );
    const scoreById = new Map(hits.map((h) => [h.id, h.score]));
    return offers
      .filter((o): o is NonNullable<typeof o> => o !== null)
      .map((o) => ({ ...o, matchScore: scoreById.get(o.id) ?? 0 }));
  }

  @Get('job-offers')
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] My job offers',
    description: 'Returns the job offers created by the authenticated employer.',
  })
  @ApiResponse({ status: 200, description: 'The employer’s job offers' })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER profile' })
  async myJobOffers(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.EMPLOYER);

    return this.jobOfferService.findByEmployerId(profileId, {
      page: this.parseInt(page, 0, 10_000),
      pageSize: this.parseInt(pageSize, 20, 100),
    });
  }

  @Get('received-applications')
  @ApiOperation({
    summary: '[Mobile/EMPLOYER] Applications received',
    description:
      'Applications submitted to the employer’s offers. Powers both the Candidats (roster) and Applications (pipeline) views.',
  })
  @ApiResponse({ status: 200, description: 'Received applications' })
  @ApiResponse({ status: 403, description: 'Not an EMPLOYER profile' })
  async receivedApplications(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const profileId = req.user.profileId;
    await this.assertProfileType(profileId, ProfileType.EMPLOYER);

    return this.applicationService.findByEmployer(profileId, {
      page: this.parseInt(page, 0, 10_000),
      pageSize: this.parseInt(pageSize, 20, 100),
    });
  }

  private parseInt(value: string | undefined, fallback: number, max: number) {
    const n = Number.parseInt(value ?? '', 10);
    if (Number.isNaN(n) || n < 0) return fallback;
    return Math.min(n, max);
  }

  private async assertProfileType(
    profileId: string,
    expected: ProfileType,
  ): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { profile_type: true },
    });
    if (!profile) {
      throw new ForbiddenException('Profil introuvable');
    }
    if (profile.profile_type !== expected) {
      throw new ForbiddenException(
        expected === ProfileType.WORKER
          ? 'Réservé aux travailleurs'
          : 'Réservé aux employeurs',
      );
    }
  }
}
