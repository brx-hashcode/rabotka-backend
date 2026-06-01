import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminNotificationService } from './admin-notification.service';
import type { AdminAuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { LogService } from '../log/log.service';
import { extractRequestMeta } from '../../common/utils/request-meta.util';

@Controller('admin/notifications')
@UseGuards(AdminAuthGuard, RolesGuard)
export class AdminNotificationController {
  constructor(
    private readonly service: AdminNotificationService,
    private readonly logService: LogService,
  ) {}

  @Get()
  @Roles(UserRole.MODERATOR)
  async list() {
    const [notifications, unreadCount] = await Promise.all([
      this.service.findRecent(50),
      this.service.countUnread(),
    ]);
    return { notifications, unreadCount };
  }

  @Post('mark-read')
  @Roles(UserRole.MODERATOR)
  async markAllRead(@Req() req: AdminAuthenticatedRequest) {
    await this.service.markAllRead();
    await this.logService.create({
      action: 'NOTIFICATION_MARKED_READ',
      entityType: 'notification',
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return { ok: true };
  }

  @Post('clear')
  @Roles(UserRole.MANAGER)
  async clear(@Req() req: AdminAuthenticatedRequest) {
    await this.service.clearAll();
    await this.logService.create({
      action: 'NOTIFICATION_CLEARED',
      entityType: 'notification',
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return { ok: true };
  }

  @Delete(':id')
  @Roles(UserRole.MODERATOR)
  async deleteOne(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.service.deleteOne(id);
    await this.logService.create({
      action: 'NOTIFICATION_DELETED',
      entityType: 'notification',
      entityId: id,
      userId: req.user?.userId,
      ...extractRequestMeta(req),
    });
    return { ok: true };
  }
}
