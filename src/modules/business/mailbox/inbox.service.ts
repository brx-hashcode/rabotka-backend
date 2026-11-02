import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { kycBucket } from '../../../common/services/storage/kyc-bucket';
import { StorageService } from '../../../common/services/storage/storage.service';
import { SystemConfigService } from '../../system-config/system-config.service';
import { slugBase } from '../careers/careers-slug';
import { cvFileType } from '../cv-screening/cv-files';
import { cvKind, senderName } from './cv-attachments';
import type { CvMail } from './providers/mail-provider';

/** Larger than any plan accepts: the plan's own limit is checked by the analysis. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_MAIL = 10;
/** Far above a real business's day; it caps what a leaked address can cost. */
const MAX_MAILS_PER_DAY = 300;
const PAGE_SIZE = 20;
export const INBOX_RETENTION_DAYS = 90;

export type InboxFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  key: string;
  bucket: string;
};

export type InboundMail = {
  to: string;
  from?: string;
  subject?: string;
};

/**
 * CVs a business forwards to its own address (`<token>@cv.rabotka.work`).
 *
 * Cloudflare Email Routing hands the mail to a Worker, which posts the
 * attachments here with a shared secret. Only CV files are kept; the business
 * picks from them in « Analyse de CV » like from a connected mailbox, so no
 * Google or Microsoft permission is involved.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);
  private readonly secret: string | undefined;
  readonly domain: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly systemConfig: SystemConfigService,
    private readonly config: ConfigService,
  ) {
    this.secret = config.get<string>('INBOUND_MAIL_SECRET') || undefined;
    this.domain = (
      config.get<string>('INBOUND_MAIL_DOMAIN') || 'cv.rabotka.work'
    ).toLowerCase();
  }

  /** Whether forwarding is set up here: without the secret, nothing can arrive. */
  get available(): boolean {
    return !!this.secret;
  }

  /** The business's forwarding address, made on first use. */
  async address(businessId: string): Promise<string> {
    const b = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true, inbox_token: true },
    });
    if (!b) throw new NotFoundException('Organisation introuvable.');
    const token = b.inbox_token ?? (await this.newToken(businessId, b.name));
    return `${token}@${this.domain}`;
  }

  /** A new address, when the old one was given out too widely. */
  async regenerate(businessId: string): Promise<string> {
    const b = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true },
    });
    if (!b) throw new NotFoundException('Organisation introuvable.');
    return `${await this.newToken(businessId, b.name)}@${this.domain}`;
  }

  /** One forwarded mail, from the Worker. Mails with no CV are dropped. */
  async receive(
    secret: string | undefined,
    mail: InboundMail,
    files: Express.Multer.File[],
  ): Promise<{ stored: number }> {
    if (!this.secret) {
      throw new ServiceUnavailableException('Inbound mail is not configured.');
    }
    if (!secret || !safeEqual(secret, this.secret)) {
      throw new UnauthorizedException();
    }

    const [local, domain] = (mail.to ?? '').trim().toLowerCase().split('@');
    if (!local || domain !== this.domain) {
      throw new NotFoundException('Unknown address.');
    }
    const business = await this.prisma.business.findUnique({
      where: { inbox_token: local },
      select: { id: true, deleted_at: true },
    });
    if (!business || business.deleted_at) {
      throw new NotFoundException('Unknown address.');
    }

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const today = await this.prisma.businessInboxMail.count({
      where: { business_id: business.id, created_at: { gte: since } },
    });
    if (today >= MAX_MAILS_PER_DAY) {
      throw new ForbiddenException('Too many mails today.');
    }

    const cvs = files
      .slice(0, MAX_FILES_PER_MAIL)
      .filter(
        (f) =>
          f.size > 0 &&
          f.size <= MAX_FILE_BYTES &&
          cvKind(f.originalname) !== null &&
          cvFileType(f.buffer, f.mimetype) !== null,
      );
    if (cvs.length === 0) return { stored: 0 };

    const id = randomUUID();
    const bucket = await kycBucket(this.systemConfig, this.config);
    const stored: InboxFile[] = [];
    for (const f of cvs) {
      const mime = cvFileType(f.buffer, f.mimetype) as string;
      const { key } = await this.storage.upload(
        f.buffer,
        `${randomUUID()}.${extension(f.originalname)}`,
        {
          folder: `business-inbox/${business.id}/${id}`,
          mimeType: mime,
          access: 'private',
          bucket,
        },
      );
      stored.push({
        id: String(stored.length),
        name: f.originalname.slice(0, 200),
        mime,
        size: f.size,
        key,
        bucket,
      });
    }

    await this.prisma.businessInboxMail.create({
      data: {
        id,
        business_id: business.id,
        from_name: senderName(mail.from).slice(0, 200),
        subject: (mail.subject ?? '').slice(0, 300),
        files: stored,
      },
    });
    return { stored: stored.length };
  }

  /** The forwarded mails, newest first, in the shape of a connected mailbox. */
  async list(
    businessId: string,
    opts: { q?: string; page?: string },
  ): Promise<{ mails: CvMail[]; next: string | null }> {
    const offset = Math.max(0, Number(opts.page) || 0);
    const q = opts.q?.trim();
    const rows = await this.prisma.businessInboxMail.findMany({
      where: {
        business_id: businessId,
        ...(q
          ? {
              OR: [
                { subject: { contains: q, mode: 'insensitive' } },
                { from_name: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { created_at: 'desc' },
      skip: offset,
      take: PAGE_SIZE + 1,
    });
    return {
      mails: rows.slice(0, PAGE_SIZE).map((r) => ({
        id: r.id,
        fromName: r.from_name,
        subject: r.subject,
        date: r.created_at.toISOString(),
        attachments: (r.files as InboxFile[]).map((f) => ({
          id: f.id,
          name: f.name,
          size: f.size,
          mime: f.mime,
        })),
      })),
      next: rows.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
    };
  }

  /** One kept CV file, for a preview or an analysis. */
  async attachment(businessId: string, mailId: string, fileId: string) {
    const mail = await this.prisma.businessInboxMail.findFirst({
      where: { id: mailId, business_id: businessId },
    });
    const file = (mail?.files as InboxFile[] | undefined)?.find(
      (f) => f.id === fileId,
    );
    if (!file) throw new NotFoundException('Pièce jointe introuvable.');
    const { body } = await this.storage.download(file.key, {
      bucket: file.bucket,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.from(chunk));
    }
    return { name: file.name, mime: file.mime, buffer: Buffer.concat(chunks) };
  }

  /** Forwarded CVs go after a while, files and row alike. */
  async purge(now = new Date()): Promise<number> {
    const before = new Date(
      now.getTime() - INBOX_RETENTION_DAYS * 24 * 3600 * 1000,
    );
    const due = await this.prisma.businessInboxMail.findMany({
      where: { created_at: { lt: before } },
      take: 200,
    });
    for (const mail of due) {
      for (const f of mail.files as InboxFile[]) {
        await this.storage
          .delete(f.key, { bucket: f.bucket })
          .catch((err) =>
            this.logger.warn(`Inbox file not deleted: ${String(err)}`),
          );
      }
      await this.prisma.businessInboxMail.delete({ where: { id: mail.id } });
    }
    return due.length;
  }

  private async newToken(businessId: string, name: string): Promise<string> {
    const base = slugBase(name).slice(0, 24).replace(/-+$/, '') || 'cv';
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = `${base}-${randomBytes(4).toString('hex').slice(0, 5)}`;
      try {
        await this.prisma.business.update({
          where: { id: businessId },
          data: { inbox_token: token },
        });
        return token;
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
    throw new Error('No free inbox token');
  }
}

function extension(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin';
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
