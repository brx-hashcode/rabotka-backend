import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AccountStatus,
  IdentityCheck,
  IdentityCheckStatus,
  KycDocumentCategory,
  Prisma,
} from '@prisma/client';
import type Redis from 'ioredis';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { QueueService } from '../../common/services/queue/queue.service';
import { IDENTITY_CHECK_QUEUE } from '../../common/services/queue/queue.module';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { toDigits, toE164 } from '../whatsapp/contracts/address';
import { WhatsAppLoginLinkService } from '../auth/whatsapp-login-link.service';
import { LogService } from '../log/log.service';
import { OAuthSandboxService } from '../oauth/services/oauth-sandbox.service';
import type { OAuthAppRow } from '../oauth/services/oauth-app.service';
import { maskPhone } from '../oauth/utils/claims.util';
import type { CreateIdentityCheckDto } from './dto';
import {
  APP_CHECKS_PER_MINUTE,
  CLAIMED_RETENTION_DAYS,
  IDENTITY_CHECK_KEYS,
  IDENTITY_CHECK_TTL_MS,
  MAX_CONSENT_REQUESTS_PER_PHONE_PER_DAY,
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_MAX_ATTEMPTS,
  identityCheckCtaPath,
} from './identity-check.constants';
import { toPartnerView, type PartnerCheckView } from './identity-check.view';
import { partnerError } from './partner-error';
import {
  scoreIdentity,
  type ClaimedIdentity,
  type StoredIdentity,
} from './scoring/score';

export type IdentityCheckJob =
  | { type: 'send_consent'; checkId: string }
  | { type: 'deliver_webhook'; checkId: string }
  | { type: 'sweep' };

/** Stored in `IdentityCheck.claimed`. */
type StoredClaim = ClaimedIdentity;

export type ConsentView = {
  id: string;
  status: 'pending' | 'approved' | 'declined' | 'expired';
  expiresAt: string;
  app: { name: string; description: string; logoUrl: string | null };
  claimed: StoredClaim | null;
};

type RequestMeta = { ipAddress?: string; userAgent?: string };

const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const SWEEP_BATCH = 500;

@Injectable()
export class IdentityCheckService {
  private readonly logger = new Logger(IdentityCheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    private readonly whatsApp: WhatsAppService,
    private readonly loginLink: WhatsAppLoginLinkService,
    private readonly logs: LogService,
    private readonly sandbox: OAuthSandboxService,
  ) {}

  // ---------------------------------------------------------------------------
  // Partner side
  // ---------------------------------------------------------------------------

  /**
   * Opens a check. The answer is the same `pending_consent` whether or not
   * the number belongs to anyone; the WhatsApp message goes out from the
   * queue, so the response time does not depend on it either.
   */
  async create(
    app: OAuthAppRow,
    dto: CreateIdentityCheckDto,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
  ): Promise<PartnerCheckView> {
    await this.enforceAppRate(app.id);

    const phone = toE164(dto.phone);
    if (!E164_PATTERN.test(phone)) {
      throw partnerError(
        400,
        'invalid_phone',
        'phone must be an international number with its country code, e.g. +242061234567.',
      );
    }

    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(app.id, idempotencyKey);
      if (existing) return this.replay(existing, phone);
    }

    const profileId = this.sandbox.isSandboxApp(app)
      ? null
      : await this.resolveProfile(app.id, phone);

    const claimed: StoredClaim = {
      firstName: dto.first_name.trim(),
      lastName: dto.last_name.trim(),
      countryCode: dto.country_code?.toUpperCase() ?? null,
      city: dto.city?.trim() || null,
      documentType: dto.document_type ?? null,
    };

    let check: IdentityCheck;
    try {
      check = await this.prisma.identityCheck.create({
        data: {
          app_id: app.id,
          profile_id: profileId,
          phone_e164: phone,
          claimed: claimed,
          reference: dto.reference?.trim() || null,
          idempotency_key: idempotencyKey ?? null,
          expires_at: new Date(Date.now() + IDENTITY_CHECK_TTL_MS),
        },
      });
    } catch (err) {
      // Two concurrent retries with one key: the loser returns the winner.
      if (idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.findByIdempotencyKey(
          app.id,
          idempotencyKey,
        );
        if (existing) return this.replay(existing, phone);
      }
      throw err;
    }

    await this.enqueue({ type: 'send_consent', checkId: check.id });

    await this.logs.create({
      action: 'IDENTITY_CHECK_CREATED',
      entityType: 'IdentityCheck',
      entityId: check.id,
      profileId: profileId ?? undefined,
      metadata: {
        clientId: app.client_id,
        phone: maskPhone(phone),
        consentRequested: profileId !== null,
        sandbox: this.sandbox.isSandboxApp(app),
      },
      ...meta,
    });

    return toPartnerView(check);
  }

  async getForApp(app: OAuthAppRow, id: string): Promise<PartnerCheckView> {
    const check = await this.prisma.identityCheck.findFirst({
      where: { id, app_id: app.id },
    });
    if (!check) {
      throw partnerError(404, 'not_found', 'No such identity check.');
    }

    if (isExpiredPending(check)) {
      return toPartnerView(await this.closeExpired(check.id));
    }
    return toPartnerView(check);
  }

  // ---------------------------------------------------------------------------
  // Person side
  // ---------------------------------------------------------------------------

  async getForProfile(profileId: string, id: string): Promise<ConsentView> {
    const check = await this.prisma.identityCheck.findFirst({
      where: { id, profile_id: profileId },
      include: {
        app: { select: { name: true, description: true, logo_url: true } },
      },
    });
    if (!check) throw partnerError(404, 'not_found', 'Demande introuvable.');

    return {
      id: check.id,
      status: consentStatus(check),
      expiresAt: check.expires_at.toISOString(),
      app: {
        name: check.app.name,
        description: check.app.description,
        logoUrl: check.app.logo_url,
      },
      claimed: (check.claimed as StoredClaim | null) ?? null,
    };
  }

  async approve(
    profileId: string,
    id: string,
    meta: RequestMeta,
  ): Promise<ConsentView> {
    const check = await this.pendingFor(profileId, id);
    const stored = await this.storedIdentity(profileId);
    const result = scoreIdentity(check.claimed as StoredClaim, stored);

    await this.decide(check.id, profileId, {
      status: IdentityCheckStatus.COMPLETED,
      declined: false,
      result: result,
      score: result.score,
    });

    await this.logs.create({
      action: 'IDENTITY_CHECK_APPROVED',
      entityType: 'IdentityCheck',
      entityId: check.id,
      profileId,
      metadata: {
        score: result.score,
        recommendation: result.recommendation,
      },
      ...meta,
    });

    return this.getForProfile(profileId, id);
  }

  async decline(
    profileId: string,
    id: string,
    meta: RequestMeta,
  ): Promise<ConsentView> {
    const check = await this.pendingFor(profileId, id);

    await this.decide(check.id, profileId, {
      status: IdentityCheckStatus.NOT_COMPLETED,
      declined: true,
    });

    await this.logs.create({
      action: 'IDENTITY_CHECK_DECLINED',
      entityType: 'IdentityCheck',
      entityId: check.id,
      profileId,
      ...meta,
    });

    return this.getForProfile(profileId, id);
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  /** Asks the person on WhatsApp. Throws when the send fails, so it retries. */
  async sendConsent(checkId: string): Promise<void> {
    const check = await this.prisma.identityCheck.findUnique({
      where: { id: checkId },
      include: {
        app: { select: { name: true, is_sandbox: true } },
        profile: {
          select: { phone: true, first_name: true, status: true },
        },
      },
    });
    if (!check || check.status !== IdentityCheckStatus.PENDING_CONSENT) return;

    if (this.sandbox.isSandboxApp(check.app)) {
      await this.resolveSandbox(check);
      return;
    }

    const { profile } = check;
    if (!profile || check.consent_sent_at || isExpiredPending(check)) return;
    if (profile.status === AccountStatus.BANNED) return;

    const path = identityCheckCtaPath(check.id);
    const sent = await this.sendConsentMessage(check.profile_id!, {
      phone: profile.phone,
      firstName: profile.first_name,
      partnerName: check.app.name,
      path,
    });

    if (!sent) {
      throw new Error(`Consent request for identity check ${checkId} not sent`);
    }

    await this.prisma.identityCheck.updateMany({
      where: { id: checkId, consent_sent_at: null },
      data: { consent_sent_at: new Date() },
    });
  }

  /** Closes expired checks and forgets old claims. */
  async sweep(): Promise<{ expired: number; purged: number }> {
    const now = new Date();

    const due = await this.prisma.identityCheck.findMany({
      where: {
        status: IdentityCheckStatus.PENDING_CONSENT,
        expires_at: { lte: now },
      },
      select: { id: true },
      take: SWEEP_BATCH,
    });
    for (const { id } of due) await this.closeExpired(id);

    const cutoff = new Date(
      now.getTime() - CLAIMED_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const purged = await this.prisma.identityCheck.updateMany({
      where: {
        status: { not: IdentityCheckStatus.PENDING_CONSENT },
        created_at: { lt: cutoff },
        NOT: { claimed: { equals: Prisma.AnyNull } },
      },
      data: { claimed: Prisma.DbNull },
    });

    return { expired: due.length, purged: purged.count };
  }

  async enqueue(job: IdentityCheckJob): Promise<void> {
    const queue = this.queue.getQueue(IDENTITY_CHECK_QUEUE);

    if (job.type === 'deliver_webhook') {
      await queue.add(job.type, job, {
        jobId: `webhook-${job.checkId}`,
        attempts: WEBHOOK_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: WEBHOOK_BACKOFF_MS },
      });
      return;
    }

    await queue.add(job.type, job);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async enforceAppRate(appId: string): Promise<void> {
    const minute = Math.floor(Date.now() / 60_000);
    const key = IDENTITY_CHECK_KEYS.appRate(appId, minute);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 120);

    if (count > APP_CHECKS_PER_MINUTE) {
      throw partnerError(
        429,
        'rate_limited',
        `At most ${APP_CHECKS_PER_MINUTE} identity checks per minute.`,
      );
    }
  }

  private findByIdempotencyKey(appId: string, key: string) {
    return this.prisma.identityCheck.findUnique({
      where: {
        idx_identity_check_app_idempotency: {
          app_id: appId,
          idempotency_key: key,
        },
      },
    });
  }

  private replay(existing: IdentityCheck, phone: string): PartnerCheckView {
    if (existing.phone_e164 !== phone) {
      throw partnerError(
        409,
        'idempotency_conflict',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    return toPartnerView(existing);
  }

  /**
   * The profile behind a number, when a consent request may be sent to it.
   *
   * `profiles.phone` is not stored in one canonical form, so both the E.164
   * and the bare-digits spelling are tried. Null when there is no such
   * account, when it is banned, or when this app already asked this number
   * the daily maximum — in which case the check simply expires unanswered.
   */
  private async resolveProfile(
    appId: string,
    phone: string,
  ): Promise<string | null> {
    const profile = await this.prisma.profile.findFirst({
      where: {
        phone: { in: [phone, toDigits(phone)] },
        deleted_at: null,
        status: { not: AccountStatus.BANNED },
      },
      select: { id: true },
    });
    if (!profile) return null;

    const recent = await this.prisma.identityCheck.count({
      where: {
        app_id: appId,
        phone_e164: phone,
        profile_id: { not: null },
        created_at: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });
    if (recent >= MAX_CONSENT_REQUESTS_PER_PHONE_PER_DAY) {
      this.logger.warn(
        `App ${appId} reached the consent cap for ${maskPhone(phone)}; no request sent`,
      );
      return null;
    }

    return profile.id;
  }

  /**
   * An interactive message when the 24h window is open (free), the approved
   * template otherwise.
   */
  private async sendConsentMessage(
    profileId: string,
    p: { phone: string; firstName: string; partnerName: string; path: string },
  ): Promise<boolean> {
    const window = await this.whatsApp
      .isServiceWindowOpen(profileId)
      .catch(() => ({ open: false }));

    if (window.open) {
      const url = await this.loginLink.shortLink(profileId, p.path);
      if (url) {
        const sent = await this.whatsApp.sendInteractiveCta(p.phone, {
          body:
            `Bonjour *${p.firstName}*,\n\n` +
            `*${p.partnerName}* vous demande l’autorisation de confirmer votre identité auprès de Rabotka.\n\n` +
            'Si vous acceptez, *Rabotka indiquera uniquement si les informations ' +
            'transmises correspondent à votre profil vérifié.*\n' +
            '*Aucun document ni aucune donnée de votre profil ne sera partagé.*\n\n' +
            '*Cette demande expire dans 24 heures* si nous ne recevons pas de ' +
            'réponse de votre part.\n\n' +
            '*L’équipe Rabotka*',
          buttonText: 'Voir la demande',
          url,
          profileId,
        });
        if (sent) return true;
      }
    }

    const loginCode = await this.loginLink
      .mint(profileId, p.path)
      .catch(() => null);

    return this.whatsApp.sendTemplateMessage(
      p.phone,
      'identityCheckConsent',
      {
        firstName: p.firstName,
        partnerName: p.partnerName,
        path: p.path,
        loginCode,
      },
      profileId,
    );
  }

  /**
   * A sandbox app never reaches a real person. A sandbox number is approved
   * on the spot; any other number ends unanswered, as a real unknown number
   * would — only without the 24h wait.
   */
  private async resolveSandbox(check: IdentityCheck): Promise<void> {
    const user = this.sandbox.findUserByPhone(check.phone_e164);

    if (!user) {
      await this.finish(check.id, {
        status: IdentityCheckStatus.NOT_COMPLETED,
        declined: false,
      });
      return;
    }

    const result = scoreIdentity(check.claimed as StoredClaim, {
      firstName: user.first_name,
      lastName: user.last_name,
      countryCode: user.country_code,
      city: user.city,
      documentType: null,
      verificationStatus: user.verification_status,
      verifiedAt: user.verified_at,
      accountStatus: user.status,
    });

    await this.finish(check.id, {
      status: IdentityCheckStatus.COMPLETED,
      sandbox_subject: user.id,
      declined: false,
      result: result,
      score: result.score,
    });
  }

  private async pendingFor(
    profileId: string,
    id: string,
  ): Promise<IdentityCheck> {
    const check = await this.prisma.identityCheck.findFirst({
      where: { id, profile_id: profileId },
    });
    if (!check) throw partnerError(404, 'not_found', 'Demande introuvable.');

    if (
      check.status !== IdentityCheckStatus.PENDING_CONSENT ||
      isExpiredPending(check)
    ) {
      throw partnerError(
        409,
        'not_pending',
        "Cette demande n'est plus en attente de réponse.",
      );
    }
    return check;
  }

  private async storedIdentity(profileId: string): Promise<StoredIdentity> {
    const profile = await this.prisma.profile.findUniqueOrThrow({
      where: { id: profileId },
      select: {
        first_name: true,
        last_name: true,
        country_code: true,
        city: true,
        verification_status: true,
        verified_at: true,
        status: true,
        kyc_documents: {
          where: { document_category: KycDocumentCategory.DOCUMENT },
          select: { document_type: true },
          take: 1,
        },
      },
    });

    return {
      firstName: profile.first_name,
      lastName: profile.last_name,
      countryCode: profile.country_code,
      city: profile.city,
      documentType: profile.kyc_documents[0]?.document_type ?? null,
      verificationStatus: profile.verification_status,
      verifiedAt: profile.verified_at,
      accountStatus: profile.status,
    };
  }

  /** The person's decision, applied only if the check is still open. */
  private async decide(
    id: string,
    profileId: string,
    data: Prisma.IdentityCheckUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await this.prisma.identityCheck.updateMany({
      where: {
        id,
        profile_id: profileId,
        status: IdentityCheckStatus.PENDING_CONSENT,
        expires_at: { gt: new Date() },
      },
      data: { ...data, decided_at: new Date() },
    });
    if (updated.count === 0) {
      throw partnerError(
        409,
        'not_pending',
        "Cette demande n'est plus en attente de réponse.",
      );
    }
    await this.enqueue({ type: 'deliver_webhook', checkId: id });
  }

  private async finish(
    id: string,
    data: Prisma.IdentityCheckUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await this.prisma.identityCheck.updateMany({
      where: { id, status: IdentityCheckStatus.PENDING_CONSENT },
      data: { ...data, decided_at: new Date() },
    });
    if (updated.count > 0) {
      await this.enqueue({ type: 'deliver_webhook', checkId: id });
    }
  }

  private async closeExpired(id: string): Promise<IdentityCheck> {
    const updated = await this.prisma.identityCheck.updateMany({
      where: {
        id,
        status: IdentityCheckStatus.PENDING_CONSENT,
        expires_at: { lte: new Date() },
      },
      data: { status: IdentityCheckStatus.NOT_COMPLETED },
    });
    if (updated.count > 0) {
      await this.enqueue({ type: 'deliver_webhook', checkId: id });
    }
    return this.prisma.identityCheck.findUniqueOrThrow({ where: { id } });
  }
}

function isExpiredPending(
  check: Pick<IdentityCheck, 'status' | 'expires_at'>,
): boolean {
  return (
    check.status === IdentityCheckStatus.PENDING_CONSENT &&
    check.expires_at.getTime() <= Date.now()
  );
}

function consentStatus(check: IdentityCheck): ConsentView['status'] {
  if (check.status === IdentityCheckStatus.COMPLETED) return 'approved';
  if (check.status === IdentityCheckStatus.PENDING_CONSENT) {
    return isExpiredPending(check) ? 'expired' : 'pending';
  }
  return check.declined ? 'declined' : 'expired';
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}
