import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { OnboardingAttemptService } from './onboarding-attempt.service';
import {
  AdminListOnboardingAttemptsDto,
  AdminOnboardingStatsDto,
} from './dto/admin-list-onboarding-attempts.dto';
import { MarkOnboardingContactedDto } from './dto/mark-contacted.dto';

/**
 * Sign-ups that started and where they stopped, for the team that calls the
 * people who did not finish. Support reaches it too (see lateral-access.ts).
 */
@ApiTags('Admin — Onboarding drop-offs')
@Controller('admin/onboarding-attempts')
@UseGuards(AdminAuthGuard, RolesGuard)
export class OnboardingAttemptAdminController {
  constructor(private readonly attempts: OnboardingAttemptService) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Sign-up attempts, most recently active first' })
  list(@Query() query: AdminListOnboardingAttemptsDto) {
    return this.attempts.listForAdmin({
      page: query.page,
      limit: query.limit,
      q: query.q,
      stage: query.stage,
      entry: query.entry,
      incomplete: query.incomplete === 'true',
      contacted:
        query.contacted === undefined ? undefined : query.contacted === 'true',
      startedFrom: query.started_from,
      startedTo: query.started_to,
    });
  }

  @Get('stats')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'The sign-up funnel: how many reached each stage' })
  stats(@Query() query: AdminOnboardingStatsDto) {
    return this.attempts.statsForAdmin({
      startedFrom: query.started_from,
      startedTo: query.started_to,
    });
  }

  @Patch(':id/contacted')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Record that someone reached out, with a note' })
  markContacted(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkOnboardingContactedDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.attempts.markContacted(id, req.user.userId, dto.note ?? null);
  }
}
