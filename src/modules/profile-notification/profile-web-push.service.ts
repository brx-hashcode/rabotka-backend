import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  WebPushService,
  type WebPushPayload,
  type WebPushTarget,
} from '../../common/services/web-push/web-push.service';
import { assertPushEndpoint } from '../../common/services/web-push/push-endpoint';

export type ProfilePushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string | null;
};

/** How many recipients a broadcast pushes to at once. */
const BROADCAST_CHUNK = 50;

const TARGET_SELECT = {
  id: true,
  endpoint: true,
  p256dh: true,
  auth: true,
} as const;

/**
 * Web Push to a profile's devices: every in-app notification also reaches the
 * phone when the client app is installed and push is on. The agent app's twin
 * is AgentWebPushService; signing and sending are WebPushService's.
 */
@Injectable()
export class ProfileWebPushService {
  private readonly logger = new Logger(ProfileWebPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webPush: WebPushService,
  ) {}

  publicKey(): Promise<string> {
    return this.webPush.publicKey();
  }

  async subscribe(profileId: string, input: ProfilePushSubscriptionInput) {
    assertPushEndpoint(input.endpoint);
    // An endpoint belongs to one browser install: if someone else signed in on
    // this phone before, it is theirs no longer.
    await this.prisma.profilePushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        profile_id: profileId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        user_agent: input.userAgent ?? null,
      },
      update: {
        profile_id: profileId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        user_agent: input.userAgent ?? null,
      },
    });
  }

  async unsubscribe(profileId: string, endpoint: string) {
    await this.prisma.profilePushSubscription.deleteMany({
      where: { profile_id: profileId, endpoint },
    });
  }

  /** Best-effort: never throws, a failed device does not stop the others. */
  async send(profileId: string, payload: WebPushPayload): Promise<void> {
    try {
      const subscriptions = await this.prisma.profilePushSubscription.findMany({
        where: { profile_id: profileId },
        select: TARGET_SELECT,
      });
      await this.deliver(subscriptions, payload);
    } catch (err) {
      this.logger.error(`Web Push for profile ${profileId} failed`, err);
    }
  }

  /**
   * One notification per recipient (a broadcast). The subscriptions are read
   * in one query — most recipients have none — and the sends go a chunk at a
   * time, so a broadcast to thousands never opens thousands of connections at
   * once. Never throws.
   */
  async sendMany(
    items: readonly { profileId: string; payload: WebPushPayload }[],
  ): Promise<void> {
    try {
      if (items.length === 0) return;
      const subscriptions = await this.prisma.profilePushSubscription.findMany({
        where: { profile_id: { in: items.map((i) => i.profileId) } },
        select: { ...TARGET_SELECT, profile_id: true },
      });
      const byProfile = new Map<string, typeof subscriptions>();
      for (const s of subscriptions) {
        byProfile.set(s.profile_id, [
          ...(byProfile.get(s.profile_id) ?? []),
          s,
        ]);
      }
      const work = items.filter((i) => byProfile.has(i.profileId));
      for (let i = 0; i < work.length; i += BROADCAST_CHUNK) {
        await Promise.all(
          work
            .slice(i, i + BROADCAST_CHUNK)
            .map(({ profileId, payload }) =>
              this.deliver(byProfile.get(profileId) ?? [], payload),
            ),
        );
      }
    } catch (err) {
      this.logger.error('Web Push for a broadcast failed', err);
    }
  }

  /** Sends, then drops the subscriptions the push service has forgotten. */
  private async deliver(
    targets: readonly WebPushTarget[],
    payload: WebPushPayload,
  ): Promise<void> {
    const { delivered, gone } = await this.webPush.deliver(targets, payload);
    if (gone.length > 0) {
      await this.prisma.profilePushSubscription.deleteMany({
        where: { id: { in: gone } },
      });
    }
    if (delivered.length > 0) {
      await this.prisma.profilePushSubscription.updateMany({
        where: { id: { in: delivered } },
        data: { last_success_at: new Date() },
      });
    }
  }
}
