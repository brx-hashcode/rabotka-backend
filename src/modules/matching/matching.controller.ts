import {
  Controller,
  Post,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { MatchingService } from './matching.service';
import { PrismaService } from '../../common/services/prisma/prisma.service';

@ApiTags('Admin — Matching')
@ApiCookieAuth()
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@Controller('admin/matching')
export class MatchingController {
  private readonly logger = new Logger(MatchingController.name);

  constructor(
    private readonly matchingService: MatchingService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('reindex')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Re-index all job offers and profiles into Qdrant (SUPER_ADMIN)',
  })
  async reindex(): Promise<{ message: string }> {
    // Fire-and-forget — runs in background, returns immediately
    this.runReindex().catch((err) =>
      this.logger.error('Re-index failed', err),
    );
    return { message: 'Re-indexing started in background' };
  }

  private async runReindex(): Promise<void> {
    this.logger.log('Re-index started');

    const [jobIds, profiles] = await Promise.all([
      this.prisma.jobOffer
        .findMany({ select: { id: true } })
        .then((rows) => rows.map((r) => r.id)),
      this.prisma.profile.findMany({
        select: { id: true, profile_type: true },
        where: { profile_type: { in: ['WORKER', 'EMPLOYER'] } },
      }),
    ]);

    this.logger.log(
      `Re-indexing ${jobIds.length} jobs and ${profiles.length} profiles`,
    );

    for (const id of jobIds) {
      await this.matchingService.indexJobOffer(id).catch(() => {});
    }

    for (const { id, profile_type } of profiles) {
      if (profile_type === 'WORKER') {
        await this.matchingService.indexWorkerProfile(id).catch(() => {});
      } else {
        await this.matchingService.indexEmployerProfile(id).catch(() => {});
      }
    }

    this.logger.log('Re-index complete');
  }
}
