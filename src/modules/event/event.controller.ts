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

@ApiTags('Admin – Events')
@Controller('admin/event')
@UseGuards(AdminAuthGuard, RolesGuard)
@ApiCookieAuth()
export class EventController {
  constructor(private readonly eventService: EventService) {}

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
  create(@Req() req: any, @Body() dto: CreateEventDto) {
    return this.eventService.create(dto, req.user.userId);
  }

  @Patch(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Update event' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEventDto) {
    return this.eventService.update(id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.MANAGER)
  @ApiOperation({ summary: 'Delete event' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.eventService.remove(id);
    return { success: true };
  }
}
