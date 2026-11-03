import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { STATS_PERIODS } from '../business-stats';
import { BusinessReportService } from './business-report.service';

/** « Rapport de recrutement » for the dashboard's period: PDF, Excel or CSV. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class BusinessReportController {
  constructor(private readonly reports: BusinessReportService) {}

  @Get('report.pdf')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'The recruitment report of the last `days` (7, 30 or 90), as a PDF',
  })
  async report(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('days') days: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.reports.pdf(
      req.user.profileId,
      period(days),
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buffer);
  }

  @Get('report.xlsx')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'The recruitment report of the last `days` (7, 30 or 90), as an Excel workbook',
  })
  async reportXlsx(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('days') days: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.reports.xlsx(
      req.user.profileId,
      period(days),
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Get('report.csv')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'The recruitment report of the last `days` (7, 30 or 90), as CSV (`;`, decimal comma, UTF-8 with BOM)',
  })
  async reportCsv(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('days') days: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { text, filename } = await this.reports.csv(
      req.user.profileId,
      period(days),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(text);
  }
}

/** 7, 30 or 90; anything else is the dashboard's default. */
function period(days: string | undefined) {
  return STATS_PERIODS.find((d) => String(d) === days) ?? 30;
}
