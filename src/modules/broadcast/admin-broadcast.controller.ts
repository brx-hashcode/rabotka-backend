import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
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
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';
import { BroadcastService } from './broadcast.service';
import type { AudienceFilters } from './audience';
import {
  CreateBroadcastDto,
  ListBroadcastsDto,
  ListRecipientsDto,
  PreviewAudienceDto,
  SendBroadcastDto,
  UpdateBroadcastDto,
} from './dto/broadcast.dto';

@ApiTags('Admin – Broadcasts')
@Controller('admin/broadcasts')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiCookieAuth()
export class AdminBroadcastController {
  constructor(
    private readonly broadcasts: BroadcastService,
    private readonly logService: LogService,
  ) {}

  /**
   * How many people these filters reach, and how many of them for free.
   *
   * A POST despite reading nothing: the filter set is a nested object with
   * arrays and dates, which does not survive a query string honestly. It is
   * called on every change in the audience builder, debounced.
   */
  @Post('audience/preview')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Count the audience for a set of filters',
    description:
      'Returns the total, the reach per channel, the free/billable WhatsApp ' +
      'split and five sample profiles. Writes nothing.',
  })
  @ApiResponse({ status: 201, description: 'Audience counts' })
  async preview(@Body() dto: PreviewAudienceDto) {
    return this.broadcasts.preview(dto.audience);
  }

  @Post('audience/facets')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'How many profiles each trade reaches',
    description:
      'Counted with the other filters applied and the trade filter removed, ' +
      'so the numbers stay true as trades are ticked. Writes nothing.',
  })
  async facets(@Body() dto: PreviewAudienceDto) {
    return this.broadcasts.categoryFacets(dto.audience);
  }

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'List broadcasts' })
  async list(@Query() dto: ListBroadcastsDto) {
    return this.broadcasts.list({
      page: dto.page ?? 1,
      limit: dto.limit ?? 10,
      ...(dto.status ? { status: dto.status } : {}),
    });
  }

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Get one broadcast' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return this.broadcasts.getOrThrow(id);
  }

  @Get(':id/recipients')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'List a broadcast’s recipients',
    description: 'The frozen audience, with each delivery’s outcome.',
  })
  async recipients(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() dto: ListRecipientsDto,
  ) {
    return this.broadcasts.listRecipients(id, {
      page: dto.page ?? 1,
      limit: dto.limit ?? 50,
      ...(dto.channel ? { channel: dto.channel } : {}),
    });
  }

  @Get(':id/stats')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({
    summary: 'Delivery counts by channel and outcome',
    description:
      'Every row counted, unlike the paginated recipients list — this is what ' +
      'the detail page charts.',
  })
  async stats(@Param('id', ParseUUIDPipe) id: string) {
    return this.broadcasts.stats(id);
  }

  @Post()
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Create a broadcast draft' })
  async create(
    @Body() dto: CreateBroadcastDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const broadcast = await this.broadcasts.create({
      title: dto.title,
      body: dto.body,
      ...(dto.link ? { link: dto.link } : {}),
      channels: dto.channels,
      audience: dto.audience,
      ...(req.user?.userId ? { createdById: req.user.userId } : {}),
    });

    await this.logService.create({
      action: 'BROADCAST_CREATED',
      entityType: 'Broadcast',
      entityId: broadcast.id,
      userId: req.user?.userId,
      metadata: { title: dto.title, channels: dto.channels },
      ...extractRequestMeta(req),
    });

    return broadcast;
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Edit a draft or a scheduled broadcast' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBroadcastDto,
  ) {
    return this.broadcasts.update(id, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
      ...(dto.link !== undefined ? { link: dto.link } : {}),
      ...(dto.channels ? { channels: dto.channels } : {}),
      ...(dto.audience ? { audience: dto.audience } : {}),
    });
  }

  @Delete(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Delete a draft' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.broadcasts.remove(id);
    return { success: true };
  }

  /**
   * Freeze the audience and start sending.
   *
   * MANAGER and above, and audited: this is the one endpoint in the product
   * that can reach thousands of people and spend real money in one call.
   */
  @Post(':id/send')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Send or schedule a broadcast',
    description:
      'Materialises the audience into recipient rows and queues the fan-out. ' +
      'Refuses an empty audience, or one above the per-send ceiling.',
  })
  @ApiResponse({ status: 201, description: 'Queued' })
  @ApiResponse({ status: 400, description: 'Empty or oversized audience' })
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendBroadcastDto,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.broadcasts.send(id, {
      ...(dto.scheduled_at ? { scheduledAt: dto.scheduled_at } : {}),
    });

    await this.logService.create({
      action: 'BROADCAST_SENT',
      entityType: 'Broadcast',
      entityId: id,
      userId: req.user?.userId,
      metadata: {
        recipientCount: result.recipientCount,
        estimatedCost: result.estimatedCost,
        scheduledAt: dto.scheduled_at?.toISOString() ?? null,
      },
      ...extractRequestMeta(req),
    });

    return result;
  }

  @Post(':id/retry')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Retry the failed deliveries',
    description:
      'Re-queues only the recipients whose delivery failed, each on its own ' +
      'channel. Anyone already reached is left alone.',
  })
  @ApiResponse({ status: 201, description: 'Retry queued' })
  @ApiResponse({ status: 400, description: 'Nothing failed, or still sending' })
  async retry(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const result = await this.broadcasts.retryFailed(id);

    await this.logService.create({
      action: 'BROADCAST_RETRIED',
      entityType: 'Broadcast',
      entityId: id,
      userId: req.user?.userId,
      metadata: { retried: result.retried },
      ...extractRequestMeta(req),
    });

    return result;
  }

  @Post(':id/cancel')
  @Roles(UserRole.MANAGER)
  @ApiOperation({
    summary: 'Cancel a scheduled or in-flight broadcast',
    description:
      'Stops at the next chunk boundary. Messages already delivered stay ' +
      'delivered — WhatsApp has no unsend.',
  })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AdminAuthenticatedRequest,
  ) {
    const broadcast = await this.broadcasts.cancel(id);

    await this.logService.create({
      action: 'BROADCAST_CANCELLED',
      entityType: 'Broadcast',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });

    return broadcast;
  }
}
