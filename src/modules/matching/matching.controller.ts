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
    this.runReindex().catch((err) => this.logger.error('Re-index failed', err));
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

    const workerIds = profiles.filter((p) => p.profile_type === 'WORKER').map((p) => p.id);
    const employerIds = profiles.filter((p) => p.profile_type === 'EMPLOYER').map((p) => p.id);

    this.logger.log(
      `Re-indexing ${jobIds.length} jobs, ${workerIds.length} workers, ${employerIds.length} employers`,
    );

    await this.batchIndex('job', jobIds, (id) => this.matchingService.indexJobOffer(id));
    await this.batchIndex('worker', workerIds, (id) => this.matchingService.indexWorkerProfile(id));
    await this.batchIndex('employer', employerIds, (id) => this.matchingService.indexEmployerProfile(id));

    this.logger.log('Re-index complete');
  }

  private async batchIndex(
    label: string,
    ids: string[],
    fn: (id: string) => Promise<void>,
    concurrency = 5,
  ): Promise<void> {
    let done = 0;
    for (let i = 0; i < ids.length; i += concurrency) {
      const batch = ids.slice(i, i + concurrency);
      await Promise.all(
        batch.map((id) =>
          fn(id).catch((err: unknown) =>
            this.logger.warn(
              `index ${label} failed for ${id}`,
              err instanceof Error ? err.message : String(err),
            ),
          ),
        ),
      );
      done += batch.length;
      this.logger.log(`Re-index ${label}: ${done}/${ids.length}`);
      // Yield to the event loop between batches so other requests are not starved
      await new Promise((r) => setImmediate(r));
    }
  }
}
