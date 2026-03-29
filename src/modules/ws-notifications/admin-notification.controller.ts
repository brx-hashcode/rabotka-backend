import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminNotificationService } from './admin-notification.service';

@Controller('admin/notifications')
@UseGuards(AdminAuthGuard)
export class AdminNotificationController {
  constructor(private readonly service: AdminNotificationService) {}

  @Get()
  async list() {
    const [notifications, unreadCount] = await Promise.all([
      this.service.findRecent(50),
      this.service.countUnread(),
    ]);
    return { notifications, unreadCount };
  }

  @Post('mark-read')
  async markAllRead() {
    await this.service.markAllRead();
    return { ok: true };
  }

  @Post('clear')
  async clear() {
    await this.service.clearAll();
    return { ok: true };
  }
}
