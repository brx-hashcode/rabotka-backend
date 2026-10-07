import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Observable, interval, map, merge, takeUntil, timer } from 'rxjs';
import { AgentNotificationService } from './agent-notification.service';
import { AgentNotificationStream } from './agent-notification-stream';
import { AgentWebPushService } from './agent-web-push.service';
import {
  AgentPushSubscribeDto,
  AgentPushUnsubscribeDto,
} from './dto/agent-notification.dto';
import {
  AgentAuthGuard,
  type AgentAuthenticatedRequest,
} from './guards/agent-auth.guard';

/** Under proxies' idle timeouts (Cloudflare: 100 s). */
const HEARTBEAT_MS = 25_000;
/**
 * Below the access token's lifetime (15 min): the stream was authorised when
 * it opened, so it ends before that authorisation would have; the app
 * reconnects, refreshing its session if needed.
 */
const STREAM_MAX_MS = 10 * 60 * 1000;

/** The agent app's bell, its live stream and its Web Push devices. */
@ApiTags('Agent – App')
@Controller('agent/notifications')
@UseGuards(AgentAuthGuard)
@ApiBearerAuth()
export class AgentNotificationController {
  constructor(
    private readonly notifications: AgentNotificationService,
    private readonly stream: AgentNotificationStream,
    private readonly push: AgentWebPushService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My notifications, newest first',
    description: '{ data, total, unread, page, limit }',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  list(
    @Req() req: AgentAuthenticatedRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.notifications.list(
      req.agent.agentId,
      Math.max(page, 1),
      Math.min(Math.max(limit, 1), 50),
    );
  }

  @Sse('stream')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({
    summary: 'Live notifications (server-sent events)',
    description:
      '`notification` events carry a notification as listed; `ping` every 25 s keeps proxies open. Closes after 10 minutes — reconnect.',
  })
  streamLive(@Req() req: AgentAuthenticatedRequest): Observable<MessageEvent> {
    const live = this.stream.forAgent(req.agent.agentId).pipe(
      map((data): MessageEvent => ({
        type: 'notification',
        data: data as object,
      })),
    );
    const ping = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ type: 'ping', data: '' })),
    );
    return merge(live, ping).pipe(takeUntil(timer(STREAM_MAX_MS)));
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all my notifications read' })
  readAll(@Req() req: AgentAuthenticatedRequest) {
    return this.notifications.markAllRead(req.agent.agentId);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark one notification read; returns the unread count',
  })
  read(
    @Req() req: AgentAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.markRead(req.agent.agentId, id);
  }

  @Get('push/key')
  @ApiOperation({
    summary: 'The Web Push (VAPID) public key to subscribe with',
  })
  async pushKey() {
    return { publicKey: await this.push.publicKey() };
  }

  @Post('push/subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive Web Push on this device' })
  async subscribe(
    @Req() req: AgentAuthenticatedRequest,
    @Body() dto: AgentPushSubscribeDto,
  ) {
    await this.push.subscribe(req.agent.agentId, {
      endpoint: dto.endpoint,
      keys: dto.keys,
      userAgent: req.headers['user-agent']?.slice(0, 255) ?? null,
    });
    return { success: true };
  }

  @Post('push/unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop Web Push on this device' })
  async unsubscribe(
    @Req() req: AgentAuthenticatedRequest,
    @Body() dto: AgentPushUnsubscribeDto,
  ) {
    await this.push.unsubscribe(req.agent.agentId, dto.endpoint);
    return { success: true };
  }
}
