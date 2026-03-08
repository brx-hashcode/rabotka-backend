import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';

export type CreateLogParams = {
  action: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  profileId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
};

export type LogEntry = {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  userId: string | null;
  userName: string | null;
  profileId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

@Injectable()
export class LogService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreateLogParams): Promise<void> {
    await this.prisma.log.create({
      data: {
        action: params.action,
        entity_type: params.entityType ?? null,
        entity_id: params.entityId ?? null,
        user_id: params.userId ?? null,
        profile_id: params.profileId ?? null,
        metadata: params.metadata
          ? (params.metadata as Prisma.InputJsonValue)
          : Prisma.DbNull,
        ip_address: params.ipAddress ?? null,
        user_agent: params.userAgent ?? null,
      },
    });
  }

  async getByProfileId(profileId: string): Promise<LogEntry[]> {
    const logs = await this.prisma.log.findMany({
      where: { profile_id: profileId },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        action: true,
        entity_type: true,
        entity_id: true,
        user_id: true,
        profile_id: true,
        metadata: true,
        created_at: true,
        user: {
          select: {
            first_name: true,
            last_name: true,
          },
        },
      },
      take: 50,
    });

    return logs.map((log) => ({
      id: log.id,
      action: log.action,
      entityType: log.entity_type,
      entityId: log.entity_id,
      userId: log.user_id,
      userName: log.user
        ? `${log.user.first_name} ${log.user.last_name}`
        : null,
      profileId: log.profile_id,
      metadata: log.metadata as Record<string, unknown> | null,
      createdAt: log.created_at,
    }));
  }
}
