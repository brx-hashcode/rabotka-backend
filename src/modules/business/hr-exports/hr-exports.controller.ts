import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ProfileAuthGuard } from '../../auth/guards/profile-auth.guard';
import { BusinessProfileGuard } from '../../auth/guards/business-profile.guard';
import type { ProfileAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import {
  HrExportsService,
  type ExportedFile,
  type ExportFormat,
} from './hr-exports.service';

const format = (value: string | undefined): ExportFormat =>
  value === 'csv' ? 'csv' : 'xlsx';

/** 30, 90 or 365 days; anything else (or nothing) means every offer. */
const days = (value: string | undefined): number | null =>
  ['30', '90', '365'].includes(value ?? '') ? Number(value) : null;

function send(res: Response, file: ExportedFile): void {
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.filename}"`,
  );
  res.setHeader('Cache-Control', 'no-store');
  if (file.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(file.text);
  } else {
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.send(file.buffer);
  }
}

/** « Exports RH » (a plan service): Excel by default, `?format=csv` for CSV. */
@ApiTags('Business')
@ApiBearerAuth()
@Controller('business/me/exports')
@UseGuards(ProfileAuthGuard, BusinessProfileGuard)
export class HrExportsController {
  constructor(private readonly exports: HrExportsService) {}

  @Get('offers/:offerId/candidates')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'An offer’s candidates (Rabotka and careers page)' })
  async candidates(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Query('format') f: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    send(
      res,
      await this.exports.candidates(req.user.profileId, offerId, format(f)),
    );
  }

  @Get('staff-register')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'The staff register: everyone hired through Rabotka',
  })
  async staffRegister(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('format') f: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    send(res, await this.exports.staffRegister(req.user.profileId, format(f)));
  }

  @Get('acpe')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Offers to declare to the ACPE (last `days`: 30, 90, 365; else all)',
  })
  async acpe(
    @Req() req: ProfileAuthenticatedRequest,
    @Query('days') d: string | undefined,
    @Query('format') f: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    send(res, await this.exports.acpe(req.user.profileId, days(d), format(f)));
  }
}
