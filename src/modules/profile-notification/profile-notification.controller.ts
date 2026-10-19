import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ProfileAuthGuard } from '../auth/guards/profile-auth.guard';
import type { ProfileAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { ProfileNotificationService } from './profile-notification.service';
import { ListProfileNotificationsDto } from './dto/list-profile-notifications.dto';
import {
  ProfilePushSubscribeDto,
  ProfilePushUnsubscribeDto,
} from './dto/profile-push-subscription.dto';
import { ProfileWebPushService } from './profile-web-push.service';

@ApiTags('Profile — Notifications')
@ApiBearerAuth()
@Controller('profile/notifications')
@UseGuards(ProfileAuthGuard)
export class ProfileNotificationController {
  constructor(
    private readonly service: ProfileNotificationService,
    private readonly push: ProfileWebPushService,
  ) {}

  @Get()
  @ApiOperation({ summary: '[Web/PROFILE] My notifications, newest first' })
  @ApiResponse({ status: 200, description: 'Paginated notifications' })
  list(
    @Req() req: ProfileAuthenticatedRequest,
    @Query() dto: ListProfileNotificationsDto,
  ) {
    return this.service.list(
      req.user.profileId,
      dto.page ?? 1,
      dto.limit ?? 20,
    );
  }

  @Get('unread-count')
  @ApiOperation({ summary: '[Web/PROFILE] Unread notification count' })
  async unreadCount(@Req() req: ProfileAuthenticatedRequest) {
    return { count: await this.service.unreadCount(req.user.profileId) };
  }

  @Post('read-all')
  @ApiOperation({ summary: '[Web/PROFILE] Mark every notification read' })
  async markAllRead(@Req() req: ProfileAuthenticatedRequest) {
    await this.service.markAllRead(req.user.profileId);
    return { success: true };
  }

  @Post('clear')
  @ApiOperation({ summary: '[Web/PROFILE] Clear every notification' })
  async clear(@Req() req: ProfileAuthenticatedRequest) {
    await this.service.dismissAll(req.user.profileId);
    return { success: true };
  }

  @Delete(':id')
  @ApiOperation({ summary: '[Web/PROFILE] Clear one notification' })
  async dismiss(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.dismiss(req.user.profileId, id);
    return { success: true };
  }

  @Post(':id/read')
  @ApiOperation({ summary: '[Web/PROFILE] Mark one notification read' })
  async markRead(
    @Req() req: ProfileAuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.markRead(req.user.profileId, id);
    return { success: true };
  }

  @Get('push/key')
  @ApiOperation({
    summary: '[Web/PROFILE] The Web Push (VAPID) public key to subscribe with',
  })
  async pushKey() {
    return { publicKey: await this.push.publicKey() };
  }

  @Post('push/subscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '[Web/PROFILE] Receive my notifications by Web Push on this device',
  })
  async pushSubscribe(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: ProfilePushSubscribeDto,
  ) {
    await this.push.subscribe(req.user.profileId, {
      endpoint: dto.endpoint,
      keys: dto.keys,
      userAgent: req.headers['user-agent']?.slice(0, 255) ?? null,
    });
    return { success: true };
  }

  @Post('push/unsubscribe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Web/PROFILE] Stop Web Push on this device' })
  async pushUnsubscribe(
    @Req() req: ProfileAuthenticatedRequest,
    @Body() dto: ProfilePushUnsubscribeDto,
  ) {
    await this.push.unsubscribe(req.user.profileId, dto.endpoint);
    return { success: true };
  }
}
