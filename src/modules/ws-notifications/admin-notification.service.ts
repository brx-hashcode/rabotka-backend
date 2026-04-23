import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import type { AdminNotificationPayload } from '../../common/events/admin-notification.events';

@Injectable()
export class AdminNotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(payload: AdminNotificationPayload): Promise<void> {
    await this.prisma.adminNotification.create({
      data: {
        event: payload.event,
        title: payload.title,
        message: payload.message,
        entity_type: payload.entityType,
        entity_id: payload.entityId,
        metadata: (payload.metadata as any) ?? undefined,
      },
    });
  }

  async findRecent(limit = 50) {
    return this.prisma.adminNotification.findMany({
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  async countUnread(): Promise<number> {
    return this.prisma.adminNotification.count({
      where: { read: false },
    });
  }

  async markAllRead(): Promise<void> {
    await this.prisma.adminNotification.updateMany({
      where: { read: false },
      data: { read: true },
    });
  }

  async clearAll(): Promise<void> {
    await this.prisma.adminNotification.deleteMany();
  }

  async deleteOne(id: string): Promise<void> {
    await this.prisma.adminNotification.delete({
      where: { id },
    });
  }
}
