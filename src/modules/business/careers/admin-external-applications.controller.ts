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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ExternalApplicationStatus, UserRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import type { Response } from 'express';

import { Roles } from '../../auth/decorators/roles.decorator';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import type { AdminAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { LogService } from '../../log/log.service';
import { sendPrivateFile } from '../../profile/send-private-file';
import { CareersService } from './careers.service';

const toArray = (v: unknown) => (typeof v === 'string' ? v.split(',') : v);

class AdminExternalApplicationsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(ExternalApplicationStatus, { each: true })
  status?: ExternalApplicationStatus[];

  @IsOptional()
  @IsUUID()
  jobOfferId?: string;

  /** A business's profile id: its careers-page applications only. */
  @IsOptional()
  @IsUUID()
  employerId?: string;
}

/**
 * Applications made from businesses' public careers pages, for admin. They
 * are not Rabotka applications (no worker profile), so they have their own
 * list beside admin's Applications.
 */
@ApiTags('Admin – Careers applications')
@Controller('admin/external-applications')
@UseGuards(AdminAuthGuard, RolesGuard)
export class AdminExternalApplicationsController {
  constructor(
    private readonly careers: CareersService,
    private readonly logs: LogService,
  ) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Careers-page applications, newest first' })
  list(@Query() query: AdminExternalApplicationsQuery) {
    return this.careers.listForAdmin({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      q: query.q,
      status: query.status,
      jobOfferId: query.jobOfferId,
      employerId: query.employerId,
    });
  }

  @Get(':id/cv')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'The CV of a careers-page application (logged)' })
  async cv(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminAuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.careers.cvFileForAdmin(id);
    await this.logs.create({
      action: 'EXTERNAL_APPLICATION_CV_VIEWED',
      entityType: 'ExternalApplication',
      entityId: id,
      userId: req.user?.userId ?? 'system',
    });
    sendPrivateFile(res, file);
  }
}
