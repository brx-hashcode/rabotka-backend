import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  WebPushService,
  type WebPushPayload,
} from '../../common/services/web-push/web-push.service';

export type AgentPushPayload = WebPushPayload;

export type AgentPushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
};

/**
 * Web Push to the agent's devices. Signing and sending are WebPushService's;
 * this keeps the agent's subscriptions — a push service answering 404/410 has
 * dropped one, and its row is deleted.
 */
@Injectable()
export class AgentWebPushService {
  private readonly logger = new Logger(AgentWebPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webPush: WebPushService,
  ) {}

  publicKey(): Promise<string> {
    return this.webPush.publicKey();
  }

  async subscribe(agentId: string, input: AgentPushSubscriptionInput) {
    // An endpoint belongs to one browser install: if another agent signed in
    // on it before, it is theirs no longer.
    await this.prisma.agentPushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        agent_id: agentId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        user_agent: input.userAgent ?? null,
      },
      update: {
        agent_id: agentId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        user_agent: input.userAgent ?? null,
      },
    });
  }

  async unsubscribe(agentId: string, endpoint: string) {
    await this.prisma.agentPushSubscription.deleteMany({
      where: { agent_id: agentId, endpoint },
    });
  }

  /** Best-effort: never throws, a failed device does not stop the others. */
  async send(agentId: string, payload: AgentPushPayload): Promise<void> {
    try {
      const subscriptions = await this.prisma.agentPushSubscription.findMany({
        where: { agent_id: agentId },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
      const { delivered, gone } = await this.webPush.deliver(
        subscriptions,
        payload,
      );
      if (gone.length > 0) {
        await this.prisma.agentPushSubscription.deleteMany({
          where: { id: { in: gone } },
        });
      }
      if (delivered.length > 0) {
        await this.prisma.agentPushSubscription.updateMany({
          where: { id: { in: delivered } },
          data: { last_success_at: new Date() },
        });
      }
    } catch (err) {
      this.logger.error(`Web Push for agent ${agentId} failed`, err);
    }
  }
}
