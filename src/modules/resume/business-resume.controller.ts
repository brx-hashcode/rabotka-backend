import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProfileType } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { BusinessSubscriptionService } from '../business/subscription/business-subscription.service';
import { ResumeService } from './resume.service';

/**
 * A candidate's Rabotka CV, for the business portal: the candidate's own CV
 * without their e-mail, phone or address. Readable for someone who applied to
 * one of the business's offers or worked on one, and otherwise for any worker
 * when the plan includes the preselection (as the worker's profile page).
 */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/candidates')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class BusinessResumeController {
  constructor(
    private readonly resumeService: ResumeService,
    private readonly prisma: PrismaService,
    private readonly subscriptions: BusinessSubscriptionService,
  ) {}

  @Get(':workerId/resume')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: "A candidate's CV as a PDF, without contacts" })
  async view(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.assertMayRead(req.user.profileId, workerId);
    const { buffer, filename } = await this.resumeService.download(workerId, {
      withContacts: false,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
  }

  private async assertMayRead(
    employerId: string,
    workerId: string,
  ): Promise<void> {
    const worker = await this.prisma.profile.findFirst({
      where: {
        id: workerId,
        profile_type: ProfileType.WORKER,
        deleted_at: null,
      },
      select: { id: true },
    });
    if (!worker) throw new NotFoundException('Candidat introuvable');

    const onOwnOffer = {
      worker_id: workerId,
      job_offer: { employer_id: employerId },
    };
    const [applied, worked] = await Promise.all([
      this.prisma.application.count({ where: onOwnOffer }),
      this.prisma.assignment.count({ where: onOwnOffer }),
    ]);
    if (applied + worked > 0) return;
    await this.subscriptions.assertFeature(employerId, 'preselection');
  }
}
