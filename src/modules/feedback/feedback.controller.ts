import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { FeedbackService } from './feedback.service';
import { AdminListFeedbackDto } from './dto/admin-list-feedback.dto';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Product feedback, for the back office.
 *
 * Read-only by design: this is what users said, and an admin editing or
 * deleting it would make the numbers beside it meaningless.
 */
@ApiTags('Admin — Feedback')
@Controller('admin/feedback')
@UseGuards(AdminAuthGuard, RolesGuard)
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Paginated feedback, newest first' })
  list(@Query() query: AdminListFeedbackDto) {
    return this.feedback.listForAdmin({
      page: query.page,
      limit: query.limit,
      q: query.q,
      score: query.score,
      withComment: query.withComment === 'true',
    });
  }

  @Get('stats')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Totals, score distribution and trend' })
  stats(@Query('days') days?: string) {
    const parsed = Number(days);
    return this.feedback.statsForAdmin(
      Number.isInteger(parsed) && parsed > 0 && parsed <= 365 ? parsed : 30,
    );
  }
}
