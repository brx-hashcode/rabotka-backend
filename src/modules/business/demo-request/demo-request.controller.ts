import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { clientIp } from '../../../common/utils/request-meta.util';
import { Public } from '../../auth/decorators/public.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AdminAuthGuard } from '../../auth/guards/admin-auth.guard';
import type { AdminAuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import {
  AdminDemoRequestsQuery,
  CreateDemoRequestDto,
  UpdateDemoRequestDto,
} from './demo-request.dto';
import { DemoRequestService } from './demo-request.service';

/** « Demander une démo », from the business site; no account needed. */
@ApiTags('Public')
@Controller('public/business/demo-requests')
export class DemoRequestPublicController {
  constructor(private readonly demos: DemoRequestService) {}

  @Public()
  @Post()
  @HttpCode(201)
  @Throttle({ default: { limit: 3, ttl: 600_000 } })
  @ApiOperation({
    summary: 'Ask for a Rabotka Business demo',
    description:
      'Saved for staff to call back; the company gets a confirmation e-mail. The same e-mail again within a day updates the first request.',
  })
  create(@Body() dto: CreateDemoRequestDto, @Req() req: Request) {
    const ua = req.headers?.['user-agent'];
    return this.demos.create(dto, {
      ip: clientIp(req),
      userAgent: typeof ua === 'string' ? ua : undefined,
    });
  }
}

/** The demo requests, for staff to follow up. */
@ApiTags('Admin – Demo requests')
@Controller('admin/demo-requests')
@UseGuards(AdminAuthGuard, RolesGuard)
export class AdminDemoRequestController {
  constructor(private readonly demos: DemoRequestService) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Demo requests, newest first' })
  list(@Query() query: AdminDemoRequestsQuery) {
    return this.demos.listForAdmin({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      q: query.q,
      status: query.status,
      country: query.country,
    });
  }

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'One demo request' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.demos.getForAdmin(id);
  }

  @Patch(':id')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Follow-up: status and notes' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDemoRequestDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    return this.demos.updateForAdmin(id, dto, req.user?.userId);
  }
}
