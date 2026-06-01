import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EventService } from './event.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { ListEventsDto } from './dto/list-events.dto';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

@ApiTags('Admin – Events')
@Controller('admin/event')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiCookieAuth()
export class EventController {
  constructor(
    private readonly eventService: EventService,
    private readonly logService: LogService,
  ) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'List events (paginated)' })
  list(@Query() dto: ListEventsDto) {
    return this.eventService.list(dto);
  }

  @Get(':id')
  @Roles(UserRole.MODERATOR)
  @ApiOperation({ summary: 'Get event by id' })
  getById(@Param('id', ParseIntPipe) id: number) {
    return this.eventService.findOne(id);
  }

  @Post()
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Create event' })
  async create(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateEventDto,
  ) {
    const event = await this.eventService.create(dto, req.user.userId);
    await this.logService.create({
      action: 'EVENT_CREATED',
      entityType: 'event',
      entityId: String((event as { id?: number | string })?.id ?? ''),
      userId: req.user?.userId,
      metadata: { ...dto },
      ...extractRequestMeta(req),
    });
    return event;
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Update event' })
  async update(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEventDto,
  ) {
    const event = await this.eventService.update(id, dto);
    await this.logService.create({
      action: 'EVENT_UPDATED',
      entityType: 'event',
      entityId: String(id),
      userId: req.user?.userId,
      metadata: { changes: { ...dto } },
      ...extractRequestMeta(req),
    });
    return event;
  }

  @Delete(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Delete event' })
  async remove(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.eventService.remove(id);
    await this.logService.create({
      action: 'EVENT_DELETED',
      entityType: 'event',
      entityId: String(id),
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return { success: true };
  }
}
