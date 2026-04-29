import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminNotificationService } from './admin-notification.service';

@Controller('admin/notifications')
@UseGuards(AdminAuthGuard, RolesGuard)
export class AdminNotificationController {
  constructor(private readonly service: AdminNotificationService) {}

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
  async markAllRead() {
    await this.service.markAllRead();
    return { ok: true };
  }

  @Post('clear')
  @Roles(UserRole.MANAGER)
  async clear() {
    await this.service.clearAll();
    return { ok: true };
  }

  @Delete(':id')
  @Roles(UserRole.MODERATOR)
  async deleteOne(@Param('id') id: string) {
    await this.service.deleteOne(id);
    return { ok: true };
  }
}
