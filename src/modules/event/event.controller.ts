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
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { EventService } from './event.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { ListEventsDto } from './dto/list-events.dto';

@ApiTags('Admin – Events')
@Controller('admin/event')
@UseGuards(AdminAuthGuard)
@ApiCookieAuth()
export class EventController {
  constructor(private readonly eventService: EventService) {}

  @Get()
  @ApiOperation({ summary: 'List events (paginated)' })
  list(@Query() dto: ListEventsDto) {
    return this.eventService.list(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get event by id' })
  getById(@Param('id', ParseIntPipe) id: number) {
    return this.eventService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create event' })
  create(@Req() req: any, @Body() dto: CreateEventDto) {
    return this.eventService.create(dto, req.user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update event' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateEventDto) {
    return this.eventService.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete event' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.eventService.remove(id);
    return { success: true };
  }
}
