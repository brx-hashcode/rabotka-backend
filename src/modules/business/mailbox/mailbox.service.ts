import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { MailProvider, type BusinessMailbox } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { businessDashboardUrl } from '../../mail/audience';
import { BusinessSubscriptionService } from '../subscription/business-subscription.service';
import type { CvUpload } from '../cv-screening/cv-screening.service';
import { cvFileType, DOCX_MIME } from '../cv-screening/cv-files';
import { MAX_MAIL_ATTACHMENTS } from './cv-attachments';
import { MailboxCrypto } from './mailbox-crypto';
import { GmailProvider } from './providers/gmail.provider';
import { OutlookProvider } from './providers/outlook.provider';
import {
  MailboxAuthError,
  type MailProviderClient,
} from './providers/mail-provider';

/** How a provider is named in urls: `gmail`, `outlook`. */
export type ProviderSlug = 'gmail' | 'outlook';

export const PROVIDER_OF: Record<ProviderSlug, MailProvider> = {
  gmail: MailProvider.GMAIL,
  outlook: MailProvider.OUTLOOK,
};

/** One CV ticked in a mail, to read into an analysis. */
export type MailAttachmentRef = {
  mailboxId: string;
  messageId: string;
  attachmentId: string;
};

type State = { b: string; p: string; v: ProviderSlug; n: string };

const STATE_AUDIENCE = 'rabotka-mailbox-connect';
/** Larger than any plan accepts: the plan's own limit is checked by the analysis. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const RECONNECT_MESSAGE =
  'Votre messagerie ne répond plus : connectez-la de nouveau.';

/**
 * The mailboxes a business connected to pick CVs from its e-mails. Mails are
 * read on demand and never stored; only the OAuth tokens are kept, sealed.
 */
@Injectable()
export class MailboxService {
  private readonly logger = new Logger(MailboxService.name);
  private readonly crypto: MailboxCrypto | null;
  private readonly providers: Record<MailProvider, MailProviderClient>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly subscriptions: BusinessSubscriptionService,
    config: ConfigService,
  ) {
    this.crypto = null;
    const key = config.get<string>('MAILBOX_TOKEN_KEY');
    try {
      if (key) this.crypto = new MailboxCrypto(key);
    } catch (err) {
      // A bad key turns the feature off; it must not stop the API from booting.
      this.logger.error(`Mailboxes disabled: ${String(err)}`);
    }
    this.providers = {
      GMAIL: new GmailProvider(
        config.get<string>('GOOGLE_MAIL_CLIENT_ID'),
        config.get<string>('GOOGLE_MAIL_CLIENT_SECRET'),
      ),
      OUTLOOK: new OutlookProvider(
        config.get<string>('MS_MAIL_CLIENT_ID'),
        config.get<string>('MS_MAIL_CLIENT_SECRET'),
      ),
    };
  }

  /** Whether a provider can be connected: its OAuth app and the token key are set. */
  available(provider: MailProvider): boolean {
    return Boolean(this.crypto) && this.providers[provider].available;
  }

  // ── Connections ──────────────────────────────────────────────────────

  async list(profileId: string) {
    const businessId = await this.businessId(profileId);
    const rows = await this.prisma.businessMailbox.findMany({
      where: { business_id: businessId },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        provider: true,
        email: true,
        created_at: true,
        expired_at: true,
      },
    });
    return {
      available: {
        gmail: this.available(MailProvider.GMAIL),
        outlook: this.available(MailProvider.OUTLOOK),
      },
      mailboxes: rows.map((r) => ({
        id: r.id,
        provider: slugOf(r.provider),
        email: r.email,
        connectedAt: r.created_at,
        expired: r.expired_at !== null,
      })),
    };
  }

  /** The consent screen's address; `state` brings the business back to us. */
  async connectUrl(profileId: string, slug: ProviderSlug) {
    const provider = PROVIDER_OF[slug];
    if (!this.available(provider)) {
      throw new ServiceUnavailableException(
        'Cette messagerie ne peut pas encore être connectée.',
      );
    }
    const businessId = await this.businessId(profileId);
    const state = await this.jwt.signAsync(
      { b: businessId, p: profileId, v: slug, n: randomUUID() } satisfies State,
      { audience: STATE_AUDIENCE, expiresIn: '10m' },
    );
    return {
      url: this.providers[provider].authUrl(state, redirectUri(slug)),
    };
  }

  /**
   * Back from the consent screen: the code becomes tokens, kept sealed.
   * Connecting the same address again replaces its tokens.
   */
  async complete(slug: ProviderSlug, code: string, state: string) {
    const provider = PROVIDER_OF[slug];
    if (!this.available(provider) || !this.crypto) {
      throw new ServiceUnavailableException('Mailbox provider not configured');
    }
    let s: State;
    try {
      s = await this.jwt.verifyAsync<State>(state, {
        audience: STATE_AUDIENCE,
      });
    } catch {
      throw new BadRequestException('Invalid or expired state');
    }
    if (s.v !== slug)
      throw new BadRequestException('State for another provider');

    const t = await this.providers[provider].exchange(code, redirectUri(slug));
    if (!t.email) throw new BadRequestException('No address for this account');
    const email = t.email.toLowerCase();
    const data = {
      connected_by_profile_id: s.p,
      refresh_token_enc: this.crypto.seal(t.refresh),
      access_token_enc: this.crypto.seal(t.access),
      access_expires_at: t.expiresAt,
      expired_at: null,
    };
    await this.prisma.businessMailbox.upsert({
      where: {
        business_id_provider_email: {
          business_id: s.b,
          provider,
          email,
        },
      },
      create: { business_id: s.b, provider, email, ...data },
      update: data,
    });
    return { email };
  }

  async disconnect(profileId: string, id: string) {
    const box = await this.owned(profileId, id);
    if (this.crypto) {
      try {
        await this.providers[box.provider].revoke(
          this.crypto.open(box.refresh_token_enc),
        );
      } catch (err) {
        this.logger.warn(`Revoking mailbox ${id} failed: ${String(err)}`);
      }
    }
    await this.prisma.businessMailbox.delete({ where: { id } });
    return { ok: true };
  }

  // ── Reading ──────────────────────────────────────────────────────────

  /** The recent mails with a CV attached, newest first. */
  async mails(profileId: string, id: string, q?: string, page?: string) {
    const box = await this.owned(profileId, id);
    return this.withAccess(box, (access) =>
      this.providers[box.provider].listCvMails(access, {
        q: q?.slice(0, 200),
        page,
      }),
    );
  }

  /**
   * One attachment, to look at before ticking it: a PDF or a photo, by what
   * its bytes are. Read on demand like the list, never stored.
   */
  async preview(
    profileId: string,
    id: string,
    messageId: string,
    attachmentId: string,
  ) {
    const box = await this.owned(profileId, id);
    const file = await this.withAccess(box, (access) =>
      this.providers[box.provider].attachment(access, messageId, attachmentId),
    ).catch((err: unknown) => {
      if (err instanceof ConflictException) throw err;
      this.logger.warn(`Mail attachment preview failed: ${String(err)}`);
      throw new NotFoundException('Cette pièce jointe n’a pas pu être lue.');
    });
    if (file.buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException('Fichier trop lourd pour un aperçu.');
    }
    const type = cvFileType(file.buffer, file.mime);
    if (!type || type === DOCX_MIME) {
      throw new UnsupportedMediaTypeException(
        'L’aperçu est disponible pour les PDF et les photos.',
      );
    }
    return { name: file.name, type, buffer: file.buffer };
  }

  /** The ticked attachments, read into files for an analysis. */
  async download(
    profileId: string,
    refs: MailAttachmentRef[],
  ): Promise<CvUpload[]> {
    if (refs.length === 0) return [];
    if (refs.length > MAX_MAIL_ATTACHMENTS) {
      throw new BadRequestException(
        `${MAX_MAIL_ATTACHMENTS} CV au plus depuis votre messagerie.`,
      );
    }
    const businessId = await this.businessId(profileId);
    const ids = [...new Set(refs.map((r) => r.mailboxId))];
    const boxes = await this.prisma.businessMailbox.findMany({
      where: { id: { in: ids }, business_id: businessId },
    });
    if (boxes.length !== ids.length) {
      throw new NotFoundException('Messagerie introuvable.');
    }
    const byId = new Map(boxes.map((b) => [b.id, b]));

    const files: CvUpload[] = [];
    for (const ref of refs) {
      const box = byId.get(ref.mailboxId)!;
      const file = await this.withAccess(box, (access) =>
        this.providers[box.provider].attachment(
          access,
          ref.messageId,
          ref.attachmentId,
        ),
      ).catch((err: unknown) => {
        if (err instanceof ConflictException) throw err;
        this.logger.warn(`Mail attachment read failed: ${String(err)}`);
        throw new BadRequestException(
          'Une pièce jointe n’a pas pu être lue depuis votre messagerie. Réessayez ou retirez-la.',
        );
      });
      if (file.buffer.length > MAX_ATTACHMENT_BYTES) {
        throw new BadRequestException(
          `« ${file.name} » est trop lourd pour être analysé.`,
        );
      }
      files.push({
        originalname: file.name,
        mimetype: file.mime,
        size: file.buffer.length,
        buffer: file.buffer,
      });
    }
    return files;
  }

  // ── Tokens ───────────────────────────────────────────────────────────

  /**
   * Runs a call with a valid access token: refreshed when it is about to
   * expire, or when the provider refuses it. A refused refresh marks the
   * mailbox expired and asks the business to connect it again.
   */
  private async withAccess<T>(
    box: BusinessMailbox,
    call: (access: string) => Promise<T>,
  ): Promise<T> {
    const crypto = this.crypto;
    if (!crypto || !this.providers[box.provider].available) {
      throw new ServiceUnavailableException(
        'Cette messagerie ne peut pas être lue pour le moment.',
      );
    }
    if (box.expired_at) throw new ConflictException(RECONNECT_MESSAGE);

    const fresh =
      box.access_token_enc &&
      box.access_expires_at &&
      box.access_expires_at.getTime() > Date.now() + 60_000;
    let access = fresh ? crypto.open(box.access_token_enc!) : null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        access ??= await this.refresh(box);
        const result = await call(access);
        await this.prisma.businessMailbox.update({
          where: { id: box.id },
          data: { last_used_at: new Date() },
        });
        return result;
      } catch (err) {
        if (!(err instanceof MailboxAuthError)) throw err;
        if (attempt === 1 || access === null) break;
        access = null; // refused: refresh once, then try again
      }
    }
    await this.prisma.businessMailbox.update({
      where: { id: box.id },
      data: { expired_at: new Date(), access_token_enc: null },
    });
    throw new ConflictException(RECONNECT_MESSAGE);
  }

  private async refresh(box: BusinessMailbox): Promise<string> {
    const crypto = this.crypto!;
    const t = await this.providers[box.provider].refresh(
      crypto.open(box.refresh_token_enc),
    );
    await this.prisma.businessMailbox.update({
      where: { id: box.id },
      data: {
        access_token_enc: crypto.seal(t.access),
        access_expires_at: t.expiresAt,
        ...(t.refresh ? { refresh_token_enc: crypto.seal(t.refresh) } : {}),
      },
    });
    return t.access;
  }

  private async owned(profileId: string, id: string) {
    const businessId = await this.businessId(profileId);
    const box = await this.prisma.businessMailbox.findFirst({
      where: { id, business_id: businessId },
    });
    if (!box) throw new NotFoundException('Messagerie introuvable.');
    return box;
  }

  private async businessId(profileId: string): Promise<string> {
    const id = await this.subscriptions.businessOf(profileId);
    if (!id)
      throw new ForbiddenException('Espace réservé aux comptes entreprise.');
    return id;
  }
}

export function slugOf(provider: MailProvider): ProviderSlug {
  return provider === MailProvider.GMAIL ? 'gmail' : 'outlook';
}

/** The consent screens come back here, through the business portal's origin. */
export function redirectUri(slug: ProviderSlug): string {
  const origin = businessDashboardUrl().replace(/\/espace$/, '');
  return `${origin}/api/v1/public/mailbox/callback/${slug}`;
}
