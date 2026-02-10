import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
  Optional,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import makeWASocket, {
  DisconnectReason,
  fetchLatestWaWebVersion,
  type WASocket,
  type BaileysEventMap,
  type WAVersion,
} from 'baileys';
import pino from 'pino';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import {
  useRedisAuthState,
  clearRedisAuthState,
} from './auth/redis-auth-state';
import type { ConversationService } from '../conversation/conversation.service';

const JID_SUFFIX = '@s.whatsapp.net';

function phoneToJid(phone: string): string {
  const digits = phone.replaceAll(/\D/g, '');
  return `${digits}${JID_SUFFIX}`;
}

function jidToPhone(jid: string): string {
  const at = jid.indexOf('@');
  if (at === -1) return jid;
  return jid.slice(0, at);
}

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private socket: WASocket | null = null;
  private connectionOpen = false;
  private sessionPrefix = 'wa:auth:';
  private initPromise: Promise<void> | null = null;
  private waVersion: WAVersion | null = null;
  private currentQr: string | null = null;

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly config: ConfigService,
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

    const logger = pino({
      level: this.config.get<string>('LOG_LEVEL', 'silent'),
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
      getMessage: () => Promise.resolve(undefined),
      markOnlineOnConnect: false,
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
      this.logger.log('WhatsApp socket connected');
    }
    if (connection === 'close') {
      this.connectionOpen = false;
      this.currentQr = null;
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
      }
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut &&
        statusCode !== DisconnectReason.badSession;
      this.logger.log(
        `WhatsApp connection closed (${statusCode ?? 'unknown'}), reconnecting: ${shouldReconnect}`,
      );
      if (shouldReconnect) {
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
      }
    }
  }

  isConnected(): boolean {
    return this.connectionOpen && this.socket != null;
  }

  getConnectionStatus(): { connected: boolean; hasQr: boolean } {
    return {
      connected: this.connectionOpen && this.socket != null,
      hasQr: this.currentQr != null,
    };
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

  async sendTextMessage(phone: string, text: string): Promise<boolean> {
    if (this.socket == null || !this.connectionOpen) {
      this.logger.warn('WhatsApp not connected; cannot send message');
      return false;
    }
    try {
      const jid = phoneToJid(phone);
      await this.socket.sendMessage(jid, { text });
      this.logger.debug(`Sent WhatsApp message to ${phone}`);
      return true;
    } catch (err) {
      this.logger.error(`Failed to send WhatsApp message to ${phone}:`, err);
      return false;
    }
  }
}
