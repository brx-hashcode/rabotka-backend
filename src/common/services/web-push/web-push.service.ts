import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

const KEY_PAIR_ID = 'default';

type VapidKeys = { publicKey: string; privateKey: string };

/** What the service workers expect: `{ id, title, body, link }`. */
export type WebPushPayload = {
  id: string;
  title: string;
  body: string;
  link: string | null;
};

export type WebPushTarget = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/** Which subscriptions took the message, and which the push service dropped. */
export type WebPushOutcome = { delivered: string[]; gone: string[] };

/**
 * Sends Web Push for both apps — the agent app's and the client's devices are
 * stored in their own tables, and each caller keeps its table tidy from the
 * outcome. One VAPID pair signs everything: from VAPID_PUBLIC_KEY /
 * VAPID_PRIVATE_KEY when both are set, otherwise from the database, where the
 * first call generates and stores it — so no environment needs a value.
 */
@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);
  private keys: Promise<VapidKeys> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async publicKey(): Promise<string> {
    return (await this.vapidKeys()).publicKey;
  }

  /**
   * Sends one payload to each target. A push service answering 404/410 has
   * dropped that subscription: it is reported in `gone`. Any other failure is
   * logged and the target simply is in neither list. Never throws.
   */
  async deliver(
    targets: readonly WebPushTarget[],
    payload: WebPushPayload,
  ): Promise<WebPushOutcome> {
    const outcome: WebPushOutcome = { delivered: [], gone: [] };
    if (targets.length === 0) return outcome;

    let options: webpush.RequestOptions;
    try {
      const keys = await this.vapidKeys();
      options = {
        vapidDetails: {
          subject: this.subject(),
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
        TTL: 24 * 60 * 60,
        urgency: 'normal',
      };
    } catch (err) {
      this.logger.error('Web Push keys unavailable', err);
      return outcome;
    }
    const body = JSON.stringify(payload);

    await Promise.all(
      targets.map(async (t) => {
        try {
          await webpush.sendNotification(
            { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
            body,
            options,
          );
          outcome.delivered.push(t.id);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            outcome.gone.push(t.id);
            return;
          }
          this.logger.warn(`Web Push failed (${status ?? 'network'})`);
        }
      }),
    );
    return outcome;
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
