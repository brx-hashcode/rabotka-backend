import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminContactRecordService } from './admin-contact-record.service';
import { AdminListContactRecordsDto } from './dto/admin-list-contact-records.dto';

@ApiTags('Admin – Contact records')
@Controller('admin/contact-records')
@UseGuards(AdminAuthGuard, RolesGuard)
@Roles(UserRole.MODERATOR)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminContactRecordController {
  constructor(private readonly contactRecords: AdminContactRecordService) {}

  // NOTE: comments must stay ABOVE the decorator block, never between the
  // decorators and the handler — `admin-routes.contract.spec.ts` scans the
  // source for a `@Roles` on every admin handler and a comment in the middle
  // hides it. See the same warning in `admin-referral.controller.ts`.
  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'List paid contacts (employer → worker)',
    description:
      'Every payment an employer made to reach a worker, from either route: MISSION (through an application on a job offer) or DIRECT (recommendation or worker search, no job). One row per payment — an employer who paid twice for the same worker has two rows.',
  })
  @ApiResponse({ status: 200, description: 'Paginated contact records' })
  async list(@Query() dto: AdminListContactRecordsDto) {
    return this.contactRecords.list(dto);
  }

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'One paid contact in full',
    description:
      'Both parties, the job offer when there is one, and the payment trail. `unlockAttempt` carries the two-sided payment state for a MISSION unlock and is null for a DIRECT one, which has no such state.',
  })
  @ApiResponse({ status: 200, description: 'Contact record detail' })
  @ApiResponse({ status: 404, description: 'Contact record not found' })
  async detail(@Param('id') id: string) {
    return this.contactRecords.detail(id);
  }
}
