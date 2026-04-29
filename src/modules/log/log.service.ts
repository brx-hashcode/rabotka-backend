import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';

export type AdminLogItem = {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  userId: string | null;
  userName: string | null;
  profileId: string | null;
  profileName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

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

  async listForAdmin(params: {
    page: number;
    limit: number;
    q?: string;
    entity_type?: string[];
    created_from?: string;
    created_to?: string;
  }): Promise<{
    data: AdminLogItem[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page, limit, q, entity_type, created_from, created_to } = params;
    const skip = (page - 1) * limit;

    const where: Prisma.LogWhereInput = {};

    const search = q?.trim() ?? '';
    if (search.length > 0) {
      where.OR = [
        { action: { contains: search, mode: 'insensitive' } },
        { entity_type: { contains: search, mode: 'insensitive' } },
        { ip_address: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (entity_type != null && entity_type.length > 0) {
      where.entity_type = { in: entity_type };
    }

    if (created_from || created_to) {
      where.created_at = {
        ...(created_from ? { gte: new Date(created_from) } : {}),
        ...(created_to
          ? { lte: new Date(new Date(created_to).setHours(23, 59, 59, 999)) }
          : {}),
      };
    }

    const [logs, total] = await Promise.all([
      this.prisma.log.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          action: true,
          entity_type: true,
          entity_id: true,
          user_id: true,
          profile_id: true,
          ip_address: true,
          user_agent: true,
          metadata: true,
          created_at: true,
          user: { select: { first_name: true, last_name: true } },
          profile: { select: { first_name: true, last_name: true } },
        },
      }),
      this.prisma.log.count({ where }),
    ]);

    const data: AdminLogItem[] = logs.map((log) => ({
      id: log.id,
      action: log.action,
      entityType: log.entity_type,
      entityId: log.entity_id,
      userId: log.user_id,
      userName: log.user
        ? `${log.user.first_name} ${log.user.last_name}`.trim()
        : null,
      profileId: log.profile_id,
      profileName: log.profile
        ? `${log.profile.first_name} ${log.profile.last_name}`.trim()
        : null,
      ipAddress: log.ip_address,
      userAgent: log.user_agent,
      metadata: log.metadata as Record<string, unknown> | null,
      createdAt: log.created_at.toISOString(),
    }));

    return { data, total, page, limit };
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
