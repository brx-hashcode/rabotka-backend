import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ReferralService } from './referral.service';
import { AdminListReferralsDto } from './dto/admin-list-referrals.dto';

@ApiTags('Admin - Referral')
@Controller('admin/referrals')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
export class AdminReferralController {
  constructor(private readonly referralService: ReferralService) {}

  // MANAGER, matching the other read-only money-adjacent admin lists: this is
  // support-desk data ("why was my parrainage not paid?"), not revenue.
  //
  // Above the decorators, not between them: the admin-route contract spec reads
  // these statically and its decorator block is whitespace-separated, so a
  // comment in the middle hides the @Roles from it.
  @Get()
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'List referrals with their payout state' })
  list(@Query() query: AdminListReferralsDto) {
    return this.referralService.listForAdmin(query);
  }

  @Get('stats')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Referral counts by status and total paid out' })
  stats() {
    return this.referralService.getAdminStats();
  }
}
