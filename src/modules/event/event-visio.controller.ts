import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { EventVisioService } from './services/event-visio.service';

/**
 * The visio of an HR event, for the profiles invited to it: no account, only
 * the personal link they received (`/reunion/<room>?t=…`).
 */
@ApiTags('Event visio')
@Controller('public/event-visio')
export class EventVisioController {
  constructor(private readonly visio: EventVisioService) {}

  @Public()
  @Get(':room')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Join an HR event visio by a personal link' })
  join(@Param('room') room: string, @Query('t') t?: string) {
    return this.visio.joinAsProfile(room, String(t ?? '').slice(0, 200));
  }
}
