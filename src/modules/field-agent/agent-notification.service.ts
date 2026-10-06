import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AgentNotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  renderAgentNotification,
  type AgentNotificationInput,
} from './agent-notification-catalog';
import { AgentNotificationStream } from './agent-notification-stream';
import { AgentWebPushService } from './agent-web-push.service';

export type AgentNotificationDto = {
  id: string;
  type: AgentNotificationType;
  title: string;
  body: string;
  link: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  readAt: Date | null;
};

const SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  link: true,
  metadata: true,
  created_at: true,
  read_at: true,
} as const satisfies Prisma.AgentNotificationSelect;

type Row = Prisma.AgentNotificationGetPayload<{ select: typeof SELECT }>;

const toDto = (row: Row): AgentNotificationDto => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.body,
  link: row.link,
  metadata: row.metadata,
  createdAt: row.created_at,
  readAt: row.read_at,
});

/** Everything but the type: the facts behind the copy, for clients that want them. */
function metadataOf(input: AgentNotificationInput): Prisma.InputJsonValue {
  const { type: _type, ...rest } = input;
  return rest;
}

/**
 * The agent app's notifications: stored for the bell, published live to the
 * agent's open app (AgentNotificationStream) and sent by Web Push to their
 * devices.
 */
@Injectable()
export class AgentNotificationService {
  private readonly logger = new Logger(AgentNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stream: AgentNotificationStream,
    private readonly push: AgentWebPushService,
  ) {}

  /**
   * Never throws: a notification is a side effect of a business event that
   * already happened, and must not fail it. `dedupeKey` makes it once-only —
   * a retried sweep or a replayed event is skipped.
   */
  async notify(
    agentId: string,
    input: AgentNotificationInput,
    dedupeKey?: string,
  ): Promise<AgentNotificationDto | null> {
    try {
      const rendered = renderAgentNotification(input);
      const row = await this.prisma.agentNotification.create({
        data: {
          agent_id: agentId,
          type: rendered.type,
          title: rendered.title,
          body: rendered.body,
          link: rendered.link,
          metadata: metadataOf(input),
          dedupe_key: dedupeKey ?? null,
        },
        select: SELECT,
      });
      const dto = toDto(row);
      await this.stream.publish(agentId, dto);
      await this.push.send(agentId, {
        id: dto.id,
        title: dto.title,
        body: dto.body,
        link: dto.link,
      });
      return dto;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return null;
      }
      this.logger.error(
        `Could not notify agent ${agentId} (${input.type})`,
        err,
      );
      return null;
    }
  }

  async list(agentId: string, page: number, limit: number) {
    const [rows, total, unread] = await Promise.all([
      this.prisma.agentNotification.findMany({
        where: { agent_id: agentId },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: SELECT,
      }),
      this.prisma.agentNotification.count({ where: { agent_id: agentId } }),
      this.prisma.agentNotification.count({
        where: { agent_id: agentId, read_at: null },
      }),
    ]);
    return { data: rows.map(toDto), total, unread, page, limit };
  }

  async markRead(agentId: string, id: string): Promise<{ unread: number }> {
    const { count } = await this.prisma.agentNotification.updateMany({
      where: { id, agent_id: agentId, read_at: null },
      data: { read_at: new Date() },
    });
    if (count === 0) {
      const exists = await this.prisma.agentNotification.count({
        where: { id, agent_id: agentId },
      });
      if (!exists) throw new NotFoundException('Notification introuvable');
    }
    return { unread: await this.unread(agentId) };
  }

  async markAllRead(agentId: string): Promise<{ unread: number }> {
    await this.prisma.agentNotification.updateMany({
      where: { agent_id: agentId, read_at: null },
      data: { read_at: new Date() },
    });
    return { unread: 0 };
  }

  private unread(agentId: string): Promise<number> {
    return this.prisma.agentNotification.count({
      where: { agent_id: agentId, read_at: null },
    });
  }
}
