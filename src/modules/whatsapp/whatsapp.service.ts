import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  Optional,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  type WASocket,
  type BaileysEventMap,
  type WAVersion,
  type WAMessageKey,
} from 'baileys';
import { proto } from 'baileys/WAProto';
import pino from 'pino';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import {
  useRedisAuthState,
  clearRedisAuthState,
} from './auth/redis-auth-state';
import {
  storeMessage,
  getMessage as getStoredMessage,
} from './message-storage';
import type { ConversationService } from '../conversation/conversation.service';

const JID_SUFFIX = '@s.whatsapp.net';
const VERIFICATION_TOKEN_KEY_PREFIX = 'wa:verify:';

function phoneToJid(phone: string): string {
  const digits = phone.replaceAll(/\D/g, '');
  return `${digits}${JID_SUFFIX}`;
}

function jidToPhone(jid: string): string {
  const at = jid.indexOf('@');
  if (at === -1) return jid;
  return jid.slice(0, at);
}

export type WhatsAppConnectionStatus =
  | 'connected'
  | 'reconnecting'
  | 'unhealthy'
  | 'need_qr';

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private socket: WASocket | null = null;
  private connectionOpen = false;
  private connectionState: WhatsAppConnectionStatus = 'need_qr';
  private sessionPrefix = 'wa:auth:';
  private initPromise: Promise<void> | null = null;
  private waVersion: WAVersion | null = null;
  private currentQr: string | null = null;
  private lastSuccessfulMessage: number | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL_MS = 60000; // 1 minute
  private readonly MAX_TIME_SINCE_SUCCESS_MS = 300000; // 5 minutes
  private readonly PENDING_MESSAGE_TIMEOUT_MS = 60000; // 1 minute
  private readonly pendingMessageKeys = new Map<string, number>(); // key string -> timestamp

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Optional()
    private readonly conversationService: ConversationService | null,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabled = this.config.get<string>('WHATSAPP_ENABLED', 'true');
    if (enabled === 'false' || enabled === '0') {
      this.logger.log('WhatsApp is disabled (WHATSAPP_ENABLED=false)');
      return;
    }
    this.initPromise = this.connect();
    await this.initPromise;
  }

  onModuleDestroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.socket != null) {
      this.socket.end(undefined);
      this.socket = null;
    }
    this.connectionOpen = false;
  }

  private async connect(): Promise<void> {
    this.sessionPrefix =
      this.config.get<string>('WHATSAPP_SESSION_PREFIX', 'wa:auth:') ??
      'wa:auth:';

    const { state, saveCreds } = await useRedisAuthState(
      this.redis,
      this.sessionPrefix,
    );

    const isDevelopment = this.config.get<string>('NODE_ENV') !== 'production';
    const logger = pino({
      level: this.config.get<string>('LOG_LEVEL', 'silent'),
      transport: isDevelopment
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
              singleLine: false,
            },
          }
        : undefined,
    }).child({ module: 'baileys' });

    if (this.waVersion == null) {
      try {
        const result = await fetchLatestWaWebVersion({});
        this.waVersion = result.version;
        this.logger.log(
          `Using WhatsApp Web version [${this.waVersion.join(', ')}]`,
        );
      } catch (err) {
        this.logger.warn(
          'Could not fetch latest WhatsApp version; using default. Error:',
          err,
        );
        this.waVersion = [2, 3000, 1019707846];
      }
    }

    this.socket = makeWASocket({
      auth: state,
      logger,
      version: this.waVersion,
      printQRInTerminal: true,
      qrTimeout: 20000,
      getMessage: async (key: WAMessageKey) => {
        return getStoredMessage(this.redis, key);
      },
      markOnlineOnConnect: false,
      // Request full history like desktop client; helps establish Signal sessions
      // for group participants (reduces "No session record" / LID decrypt failures)
      syncFullHistory: true,
    });

    this.socket.ev.on(
      'connection.update',
      (update: Partial<BaileysEventMap['connection.update']>): void => {
        void this.handleConnectionUpdate(update);
      },
    );

    this.socket.ev.on('creds.update', () => {
      void saveCreds();
    });

    this.socket.ev.on(
      'messages.upsert',
      (event: BaileysEventMap['messages.upsert']) => {
        this.handleMessagesUpsert(event);
      },
    );

    this.socket.ev.on(
      'messages.update',
      (event: BaileysEventMap['messages.update']) => {
        void this.handleMessagesUpdate(event);
      },
    );
  }

  private async handleConnectionUpdate(
    update: Partial<BaileysEventMap['connection.update']>,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;
    if (qr != null) {
      this.currentQr = qr;
      this.logger.log(
        'Scan the QR code below with WhatsApp: Linked devices → Link a device',
      );
    }
    if (connection === 'open') {
      this.connectionOpen = true;
      this.currentQr = null;
      this.connectionState = 'connected';
      this.logger.log('WhatsApp socket connected');
      this.startHealthCheck();
    }
    if (connection === 'close') {
      this.connectionOpen = false;
      this.currentQr = null;
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
      }
      const statusCode = (
        lastDisconnect?.error as
          | { output?: { statusCode?: number } }
          | undefined
      )?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      if (isLoggedOut || statusCode === 405) {
        this.logger.log(
          `WhatsApp session invalid (${statusCode}); clearing Redis session so you can scan a new QR code.`,
        );
        await clearRedisAuthState(this.redis, this.sessionPrefix);
        this.connectionState = 'need_qr';
      }
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== DisconnectReason.badSession;
      this.logger.log(
        `WhatsApp connection closed (${statusCode ?? 'unknown'}), reconnecting: ${shouldReconnect}`,
      );
      if (shouldReconnect) {
        this.connectionState = 'reconnecting';
        setTimeout(
          () => {
            void this.connect();
          },
          statusCode === 405 ? 5000 : 3000,
        );
      }
    }
  }

  private handleMessagesUpsert(
    event: BaileysEventMap['messages.upsert'],
  ): void {
    const { messages } = event;
    for (const m of messages) {
      if (m.key.fromMe && m.message) {
        void storeMessage(this.redis, m.key, m.message).catch((err) =>
          this.logger.warn('Failed to store sent message:', err),
        );
        this.pendingMessageKeys.set(
          this.pendingMessageKeyString(m.key),
          Date.now(),
        );
      }

      if (m.key.fromMe ?? false) continue;
      const remoteJid = m.key.remoteJid;
      if (remoteJid == null) continue;
      const text =
        m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? '';
      if (text) {
        const phone = jidToPhone(remoteJid);
        if (this.conversationService == null) {
          this.logger.debug(`Incoming message from ${phone}: ${text}`);
        } else {
          this.conversationService
            .handleIncomingMessage(phone, text)
            .catch((err) =>
              this.logger.warn(
                `Error handling incoming message from ${phone}:`,
                err,
              ),
            );
        }
      } else if (m.key.participant) {
        // Group message with no decrypted content (e.g. SessionError for LID participant)
        this.logger.debug(
          `Skipping message from group ${remoteJid} participant ${m.key.participant}: decryption failed (no session record). Re-link the device or wait for syncFullHistory to establish sessions.`,
        );
      }
    }
  }

  private pendingMessageKeyString(key: WAMessageKey): string {
    return `${key.remoteJid ?? ''}:${key.id ?? ''}`;
  }

  private async handleMessagesUpdate(
    event: BaileysEventMap['messages.update'],
  ): Promise<void> {
    for (const update of event) {
      const { key, update: updateData } = update;

      if (key.fromMe && updateData?.message) {
        await storeMessage(this.redis, key, updateData.message).catch((err) =>
          this.logger.warn('Failed to store updated message:', err),
        );
        this.pendingMessageKeys.set(
          this.pendingMessageKeyString(key),
          Date.now(),
        );
      }

      const status = updateData?.status;
      const isDeliveredOrRead =
        status === proto.WebMessageInfo.Status.DELIVERY_ACK ||
        status === proto.WebMessageInfo.Status.READ;
      if (key.fromMe && isDeliveredOrRead && updateData?.message == null) {
        this.pendingMessageKeys.delete(this.pendingMessageKeyString(key));
        this.logger.debug(
          `Message ${key.id} delivered/read, will expire naturally`,
        );
      }
    }

    // If any pending message has been waiting too long, treat connection as unhealthy and refresh
    const now = Date.now();
    for (const [msgKey, timestamp] of this.pendingMessageKeys) {
      if (now - timestamp > this.PENDING_MESSAGE_TIMEOUT_MS) {
        this.logger.warn(
          `Message ${msgKey} pending for ${Math.round((now - timestamp) / 1000)}s; triggering reconnect`,
        );
        this.connectionState = 'unhealthy';
        this.pendingMessageKeys.delete(msgKey);
        void this.forceReconnect();
        break;
      }
    }
  }

  isConnected(): boolean {
    return this.connectionOpen && this.socket != null;
  }

  getConnectionStatus(): {
    status: WhatsAppConnectionStatus;
    connected: boolean;
    hasQr: boolean;
    lastSuccessfulMessage: number | null;
    connectionHealthy: boolean;
  } {
    const timeSinceLastSuccess = this.lastSuccessfulMessage
      ? Date.now() - this.lastSuccessfulMessage
      : Infinity;
    const isHealthy =
      this.connectionOpen &&
      this.socket != null &&
      (timeSinceLastSuccess < this.MAX_TIME_SINCE_SUCCESS_MS ||
        this.lastSuccessfulMessage === null);

    return {
      status: this.connectionState,
      connected: this.connectionOpen && this.socket != null,
      hasQr: this.currentQr != null,
      lastSuccessfulMessage: this.lastSuccessfulMessage,
      connectionHealthy: isHealthy,
    };
  }

  async forceReconnect(): Promise<void> {
    this.connectionState = 'reconnecting';
    this.logger.log('Forcing WhatsApp reconnection...');

    this.pendingMessageKeys.clear();

    // Stop health check
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Close existing socket
    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch (err) {
        this.logger.warn('Error closing socket:', err);
      }
      this.socket = null;
    }

    this.connectionOpen = false;
    this.lastSuccessfulMessage = null;

    // Wait a bit before reconnecting
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Reconnect
    await this.connect();
  }

  private startHealthCheck(): void {
    // Clear any existing interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(() => {
      void this.performHealthCheck();
    }, this.HEALTH_CHECK_INTERVAL_MS);
  }

  private async performHealthCheck(): Promise<void> {
    if (!this.connectionOpen || !this.socket) {
      return;
    }

    // If no successful message in last 5 minutes and we think we're connected,
    // something is wrong - force reconnect
    const timeSinceLastSuccess = this.lastSuccessfulMessage
      ? Date.now() - this.lastSuccessfulMessage
      : Infinity;

    if (
      timeSinceLastSuccess > this.MAX_TIME_SINCE_SUCCESS_MS &&
      this.lastSuccessfulMessage !== null
    ) {
      this.connectionState = 'unhealthy';
      this.logger.warn(
        `Health check failed: No successful messages in ${Math.round(timeSinceLastSuccess / 1000)}s. Forcing reconnect...`,
      );
      await this.forceReconnect();
    }
  }

  async getQrImageBuffer(): Promise<Buffer | null> {
    if (this.currentQr == null) return null;
    const QRCode = await import('qrcode');
    return await QRCode.toBuffer(this.currentQr, {
      type: 'png',
      margin: 2,
      width: 280,
    });
  }

  async sendTextMessage(
    phone: string,
    text: string,
    retries = 2,
  ): Promise<boolean> {
    if (this.socket == null || !this.connectionOpen) {
      this.logger.warn('WhatsApp not connected; cannot send message');
      return false;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const jid = phoneToJid(phone);

        // Add timeout wrapper (30 seconds)
        const sendPromise = this.socket.sendMessage(jid, { text });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Send timeout after 30s')), 30000),
        );

        const result = await Promise.race([sendPromise, timeoutPromise]);

        if (result?.key && result?.message) {
          await storeMessage(this.redis, result.key, result.message).catch(
            (err) => this.logger.warn('Failed to store sent message:', err),
          );
        }

        // Track successful send
        this.lastSuccessfulMessage = Date.now();
        this.logger.debug(`Sent WhatsApp message to ${phone}`);
        return true;
      } catch (err) {
        const isLastAttempt = attempt === retries;
        this.logger.warn(
          `Failed to send WhatsApp message to ${phone} (attempt ${attempt + 1}/${retries + 1}):`,
          err,
        );

        if (isLastAttempt) {
          this.logger.error(`All retry attempts failed for ${phone}`);
          // If all retries failed, mark connection as potentially broken
          this.connectionOpen = false;
          setTimeout(() => {
            void this.forceReconnect();
          }, 5000);
          return false;
        }

        // Exponential backoff: 1s, 2s, 4s
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt) * 1000),
        );
      }
    }
    return false;
  }

  async verifyWhatsAppToken(token: string): Promise<void> {
    if (!token || token.trim().length === 0) {
      throw new BadRequestException('Invalid verification token');
    }

    const redisKey = `${VERIFICATION_TOKEN_KEY_PREFIX}${token}`;
    const profileId = await this.redis.get(redisKey);

    if (!profileId) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        phone: true,
        first_name: true,
      },
    });

    if (!profile) {
      throw new BadRequestException('Profile not found');
    }

    await this.prisma.profile.update({
      where: { id: profileId },
      data: { whatsapp_connected: true },
    });

    await this.redis.del(redisKey);

    if (this.isConnected()) {
      const successMessage = `Bonjour ${profile.first_name},

Votre compte WhatsApp a été vérifié avec succès !

Vous pouvez maintenant accéder au menu et utiliser toutes les fonctionnalités de Rabotka.`;

      await this.sendTextMessage(profile.phone, successMessage).catch((err) =>
        this.logger.warn(
          `Failed to send WhatsApp success message to ${profile.phone}:`,
          err,
        ),
      );
    }

    this.logger.log(`WhatsApp verified successfully for profile ${profileId}`);
  }
}
