import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import webpush from 'web-push';
import { PrismaService } from '../../common/services/prisma/prisma.service';

const KEY_PAIR_ID = 'default';

type VapidKeys = { publicKey: string; privateKey: string };

export type AgentPushPayload = {
  id: string;
  title: string;
  body: string;
  link: string | null;
};

export type AgentPushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
};

/**
 * Web Push to the agent's devices. The VAPID pair comes from
 * VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY when both are set, otherwise from the
 * database, where the first call generates and stores it — so no environment
 * needs a value. A push service answering 404/410 has dropped the
 * subscription; its row is deleted.
 */
@Injectable()
export class AgentWebPushService {
  private readonly logger = new Logger(AgentWebPushService.name);
  private keys: Promise<VapidKeys> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async publicKey(): Promise<string> {
    return (await this.vapidKeys()).publicKey;
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
      if (subscriptions.length === 0) return;

      const keys = await this.vapidKeys();
      const options: webpush.RequestOptions = {
        vapidDetails: {
          subject: this.subject(),
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
        TTL: 24 * 60 * 60,
        urgency: 'normal',
      };
      const body = JSON.stringify(payload);

      await Promise.all(
        subscriptions.map(async (s) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: s.endpoint,
                keys: { p256dh: s.p256dh, auth: s.auth },
              },
              body,
              options,
            );
            await this.prisma.agentPushSubscription.update({
              where: { id: s.id },
              data: { last_success_at: new Date() },
            });
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await this.prisma.agentPushSubscription.deleteMany({
                where: { id: s.id },
              });
              return;
            }
            this.logger.warn(
              `Web Push to agent ${agentId} failed (${status ?? 'network'})`,
            );
          }
        }),
      );
    } catch (err) {
      this.logger.error(`Web Push for agent ${agentId} failed`, err);
    }
  }

  private subject(): string {
    const from = this.config.get<string>('SMTP_FROM_ADDRESS');
    return `mailto:${from || 'contact@rabotka.work'}`;
  }

  private vapidKeys(): Promise<VapidKeys> {
    this.keys ??= this.loadKeys().catch((err) => {
      this.keys = null;
      throw err;
    });
    return this.keys;
  }

  private async loadKeys(): Promise<VapidKeys> {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY');
    if (publicKey && privateKey) return { publicKey, privateKey };

    const stored = await this.prisma.webPushKeyPair.findUnique({
      where: { id: KEY_PAIR_ID },
    });
    if (stored) {
      return { publicKey: stored.public_key, privateKey: stored.private_key };
    }

    const generated = webpush.generateVAPIDKeys();
    try {
      await this.prisma.webPushKeyPair.create({
        data: {
          id: KEY_PAIR_ID,
          public_key: generated.publicKey,
          private_key: generated.privateKey,
        },
      });
      this.logger.log('Generated the Web Push (VAPID) key pair');
      return generated;
    } catch (err) {
      // Another process generated it first: use theirs.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.prisma.webPushKeyPair.findUniqueOrThrow({
          where: { id: KEY_PAIR_ID },
        });
        return { publicKey: winner.public_key, privateKey: winner.private_key };
      }
      throw err;
    }
  }
}
