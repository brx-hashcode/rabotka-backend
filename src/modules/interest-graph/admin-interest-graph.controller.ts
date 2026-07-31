import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { InterestClusterService } from './interest-cluster.service';
import { InterestSignalService } from './interest-signal.service';

@ApiTags('Admin — Interest Graph')
@ApiCookieAuth()
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@Controller('admin/interest-graph')
export class AdminInterestGraphController {
  private readonly logger = new Logger(AdminInterestGraphController.name);

  constructor(
    private readonly clusters: InterestClusterService,
    private readonly signals: InterestSignalService,
  ) {}

  @Get(':userId/profile')
  @ApiOperation({ summary: 'Get interest profile for a user' })
  async getProfile(@Param('userId') userId: string) {
    const profile = await this.clusters.getProfile(userId);
    if (!profile)
      throw new NotFoundException('No interest profile found for this user');
    return profile;
  }

  @Get(':userId/signals')
  @ApiOperation({ summary: 'Get recent signals for a user' })
  async getSignals(@Param('userId') userId: string) {
    return this.signals.getRecentSignals(userId);
  }

  @Post(':userId/reseed')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Force re-seed interest vector from profile for a user',
    description:
      'Destructive: discards the learned interest vector and rebuilds it from declared profile attributes. Admin repair only.',
  })
  async reseed(@Param('userId') userId: string): Promise<void> {
    this.logger.log(`Manual force re-seed triggered for user ${userId}`);
    await this.clusters.forceReseedFromProfile(userId);
  }
}
