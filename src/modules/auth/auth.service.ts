import {
  issueSignupToken,
  readSignupToken,
  SIGNUP_TOKEN_TTL_SECONDS,
} from './signup-token';
import {
  OnboardingAttemptService,
  type ReportableStage,
} from '../onboarding-attempt/onboarding-attempt.service';
import { mayLogSecretsLocally } from './local-dev-secrets';
import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { AccountStatus, ProfileType } from '@prisma/client';

import {
  REDIS_KEY_PREFIX,
  REDIS_CONNECTION,
} from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { LayoutService } from '../mail/layout.service';
import { LogService } from '../log/log.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { sendOtpEmail } from '../mail/templates';
import {
  WhatsAppLoginLinkService,
  canMintLoginCode,
  type WhatsAppLoginGrant,
} from './whatsapp-login-link.service';
import * as otplib from 'otplib';
import { JWT_BLOCKLIST_PREFIX } from './session-revocation';
import { adminSessionHours } from './auth-cookie.util';
import {
  assertCanSendOtp,
  consumeOtp,
  generateOtp,
  storeOtp,
  consumeOtpWithLockout,
} from './otp-store';
import * as QRCode from 'qrcode';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SESSION_ENDED,
  type SessionEndedEvent,
} from '../../common/events/session-ended.events';

const TOTP_PENDING_PREFIX = `${REDIS_KEY_PREFIX}admin:totp:pending:`;
const TOTP_PENDING_TTL = 300;

const OTP_KEY_PREFIX = `${REDIS_KEY_PREFIX}otp:`;
const MOBILE_REFRESH_PREFIX = `${REDIS_KEY_PREFIX}mobile:refresh:`;
/** The jti shape we mint (randomUUID). Anything else was not issued here. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Longer than any session we issue (30 days by default), never unbounded. */
const MAX_REVOCATION_TTL_SECONDS = 90 * 24 * 60 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 24 * 60 * 60;
const ADMIN_OTP_KEY_PREFIX = `${REDIS_KEY_PREFIX}admin:otp:`;
const RESEND_COOLDOWN_SECONDS = 60;
const RESEND_COOLDOWN_KEY_PREFIX = `${REDIS_KEY_PREFIX}otp:resend:`;
const ADMIN_RESEND_COOLDOWN_KEY_PREFIX = `${REDIS_KEY_PREFIX}admin:otp:resend:`;

// The attempt limit, send cap and check-and-delete script live in otp-store.ts,
// shared with the field-agent login.
const OTP_ATTEMPTS_KEY_PREFIX = `${REDIS_KEY_PREFIX}otp-attempts:`;
const ADMIN_OTP_ATTEMPTS_KEY_PREFIX = `${REDIS_KEY_PREFIX}admin:otp-attempts:`;
const OTP_SENDS_KEY_PREFIX = `${REDIS_KEY_PREFIX}otp-sends:`;
const ADMIN_OTP_SENDS_KEY_PREFIX = `${REDIS_KEY_PREFIX}admin:otp-sends:`;
// Signup has its own codes: a number with no account yet must never be able
// to consume (or exhaust) a login code, and the other way round.
const SIGNUP_OTP_KEY_PREFIX = `${REDIS_KEY_PREFIX}signup:otp:`;
const SIGNUP_OTP_ATTEMPTS_KEY_PREFIX = `${REDIS_KEY_PREFIX}signup:otp-attempts:`;
const SIGNUP_OTP_SENDS_KEY_PREFIX = `${REDIS_KEY_PREFIX}signup:otp-sends:`;

const TOTP_MAX_ATTEMPTS = 5;
const TOTP_ATTEMPTS_PREFIX = `${REDIS_KEY_PREFIX}admin:totp:attempts:`;

type JwtExpiresIn = `${number}${'s' | 'm' | 'h' | 'd'}` | `${number}`;

export interface MobileSessionUser {
  id: string;
  first_name: string;
  last_name: string;
  /** Null for the majority, who sign up with a phone and no email. */
  email: string | null;
  phone: string;
  avatar_url: string | null;
  profile_type: string;
  description: string;
  domains: { id: string; name: string }[];
}

export interface MobileTokens {
  token: string;
  refreshToken: string;
  user: MobileSessionUser;
}

/**
 * Whether an admin-phone token belongs to the pairing currently on the user.
 *
 * Pentest A2-F12 (#868): confirmation only checked that SOME phone was paired,
 * so pairing a replacement brought an old phone's revoked token back to life.
 * Tokens now carry `pairedAt`, which must equal `phone_paired_at`.
 *
 * Tokens issued before the claim existed have only `iat`, signed in the same
 * second as `phone_paired_at` was written; such a token is accepted only if it
 * was issued for that pairing, within a few seconds of it.
 */
const LEGACY_PAIRING_SKEW_MS = 5_000;
export function isCurrentPairing(
  token: { pairedAt?: number; iat?: number },
  phonePairedAt: Date,
): boolean {
  if (typeof token.pairedAt === 'number') {
    return token.pairedAt === phonePairedAt.getTime();
  }
  if (typeof token.iat !== 'number') return false;
  return (
    Math.abs(token.iat * 1000 - phonePairedAt.getTime()) <=
    LEGACY_PAIRING_SKEW_MS
  );
}
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly layoutService: LayoutService,
    private readonly whatsAppService: WhatsAppService,
    private readonly configService: ConfigService,
    private readonly logService: LogService,
    private readonly whatsAppLoginLink: WhatsAppLoginLinkService,
    // Appended and @Optional(): the specs build this service positionally, and
    // drop-off tracking is never something a sign-up may depend on.
    @Optional()
    private readonly onboardingAttempts?: OnboardingAttemptService,
    // Appended and optional for the same reason: closes the signed-out
    // person's open sockets (#864).
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  /**
   * Record a successful admin login in the audit log (surfaced on the admin
   * Logs page). Best-effort — a logging failure must never block the login.
   */
  private async recordAdminLogin(
    userId: string,
    method: 'otp' | 'totp' | 'qr',
    meta?: { ipAddress?: string; userAgent?: string },
  ): Promise<void> {
    await this.logService
      .create({
        action: 'admin.login',
        entityType: 'User',
        entityId: userId,
        userId,
        metadata: { method },
        ipAddress: meta?.ipAddress,
        userAgent: meta?.userAgent,
      })
      .catch((err) =>
        this.logger.warn(`Failed to record admin login for ${userId}:`, err),
      );
  }

  /**
   * Stamp `last_login_at` on a profile that just signed in.
   *
   * The counterpart to `recordAdminLogin` above: admins have had a login
   * timestamp since the start, profiles had only `first_login: boolean`, so
   * nothing distinguished a dormant account from an active one.
   *
   * Fire-and-forget, and deliberately not awaited by its callers. The token is
   * already signed by the time this runs; a failed timestamp must never turn a
   * successful authentication into a failed request.
   *
   * Called from the three real sign-in paths ONLY — not from
   * `issueMobileTokens`, which `refreshMobileTokens` also goes through. This is
   * "last authenticated", not "last seen", and a client rotating its refresh
   * token every 15 minutes would otherwise pin the value to now forever.
   */
  private recordProfileLogin(profileId: string): void {
    void this.prisma.profile
      .update({
        where: { id: profileId },
        data: { last_login_at: new Date() },
      })
      .catch((err) =>
        this.logger.warn(
          `Failed to record profile login for ${profileId}:`,
          err,
        ),
      );
  }

  /**
   * Step one of signup: a WhatsApp code to the number being registered, so
   * nobody can create an account on a number they do not hold. Refused when an
   * account already exists — the login says the same, so this reveals nothing
   * new. Same send cap as the login code (otp-store), on its own counter.
   *
   * A business signs up from a browser with its email instead: the code goes
   * by email, and the token the verification hands back says so (see
   * signup-token.ts). Same store, same cap, same refusal for a taken address.
   */
  async sendSignupOtp(
    phoneOrEmail: string,
    who: {
      firstName?: string;
      lastName?: string;
      profileType?: ProfileType;
    } = {},
  ): Promise<{ success: boolean }> {
    const normalized = this.normalize(phoneOrEmail);
    const isEmail = this.isEmail(normalized);
    if (!isEmail && !this.isPhone(normalized)) {
      throw new BadRequestException('Numéro de téléphone invalide');
    }
    if (isEmail && (await this.findProfileByEmail(normalized))) {
      throw new ConflictException(
        'Un compte existe déjà avec cette adresse e-mail. Connectez-vous.',
      );
    }
    if (!isEmail && (await this.findProfileByPhone(normalized))) {
      throw new ConflictException(
        'Un compte existe déjà avec ce numéro. Connectez-vous.',
      );
    }

    await this.assertCanSendOtp(SIGNUP_OTP_SENDS_KEY_PREFIX, normalized);

    const otp = this.generateOtp();
    this.logOtp('send', normalized, otp);
    await this.storeOtp(
      `${SIGNUP_OTP_KEY_PREFIX}${normalized}`,
      `${SIGNUP_OTP_ATTEMPTS_KEY_PREFIX}${normalized}`,
      otp,
    );
    if (isEmail) {
      await this.sendOtpByEmail(normalized, otp, who.firstName ?? '');
    } else {
      await this.sendOtpByWhatsApp(normalized, otp);
    }
    // After the send, so a refused or failed code is not an attempt. Not
    // awaited: the sign-up never waits on drop-off tracking. A business is
    // always an employer, whatever the form said.
    void this.onboardingAttempts?.codeSent(
      normalized,
      isEmail ? { ...who, profileType: ProfileType.EMPLOYER } : who,
    );

    return { success: true };
  }

  /**
   * The app reached a later sign-up screen. Keyed by the signup token rather
   * than a phone in the body, so nobody can move someone else's attempt; a
   * missing or spent token is simply not recorded.
   */
  async recordSignupProgress(
    token: string | null,
    stage: ReportableStage,
    who: { profileType?: ProfileType } = {},
  ): Promise<void> {
    if (!token || !this.onboardingAttempts) return;
    const identity = await readSignupToken(this.redis, token).catch(() => null);
    if (!identity) return;
    void this.onboardingAttempts.reached(
      identity.entry === 'business' ? identity.email : identity.phone,
      stage,
      identity.entry === 'business'
        ? { profileType: ProfileType.EMPLOYER }
        : who,
    );
  }

  /**
   * Step two: the code checks out, so the number (or the business's address)
   * is theirs. Returns the signup token the KYC upload and the profile
   * creation require (see signup-token.ts). Same attempt limit as the login
   * code.
   */
  async verifySignupOtp(
    phoneOrEmail: string,
    code: string,
  ): Promise<{ signupToken: string; expiresIn: number }> {
    const normalized = this.normalize(phoneOrEmail);
    const matched = await this.consumeOtp(
      `${SIGNUP_OTP_KEY_PREFIX}${normalized}`,
      `${SIGNUP_OTP_ATTEMPTS_KEY_PREFIX}${normalized}`,
      code.trim(),
    );
    if (!matched) {
      throw new BadRequestException('Code incorrect ou expiré');
    }
    void this.onboardingAttempts?.phoneVerified(normalized);
    // The entry is decided here, by what the code proved, and nowhere else.
    const identity = this.isEmail(normalized)
      ? ({ entry: 'business', email: normalized } as const)
      : ({ entry: 'whatsapp', phone: normalized } as const);
    return {
      signupToken: await issueSignupToken(this.redis, identity),
      expiresIn: SIGNUP_TOKEN_TTL_SECONDS,
    };
  }

  async sendOtp(emailOrPhone: string): Promise<{ success: boolean }> {
    const normalized = this.normalize(emailOrPhone);
    const isEmail = this.isEmail(normalized);
    const isPhone = this.isPhone(normalized);

    if (!isEmail && !isPhone) {
      throw new BadRequestException('Email ou numéro de téléphone invalide');
    }

    const profile = isEmail
      ? await this.findProfileByEmail(normalized)
      : await this.findProfileByPhone(normalized);

    // An archived profile cannot log in (#878) — answered as unknown.
    if (!profile || profile.deleted_at) {
      throw new NotFoundException(
        'Aucun compte trouvé pour cet email ou téléphone',
      );
    }

    await this.assertCanSendOtp(OTP_SENDS_KEY_PREFIX, normalized);

    const otp = this.generateOtp();

    this.logOtp('send', normalized, otp);

    await this.storeOtp(
      `${OTP_KEY_PREFIX}${normalized}`,
      `${OTP_ATTEMPTS_KEY_PREFIX}${normalized}`,
      otp,
    );

    if (isEmail) {
      await this.sendOtpByEmail(
        normalized,
        otp,
        profile.first_name ?? undefined,
      );
    } else {
      await this.sendOtpByWhatsApp(normalized, otp, profile.id);
    }

    return { success: true };
  }

  async resendOtp(emailOrPhone: string): Promise<{ success: boolean }> {
    const normalized = this.normalize(emailOrPhone);
    const isEmail = this.isEmail(normalized);
    const isPhone = this.isPhone(normalized);

    if (!isEmail && !isPhone) {
      throw new BadRequestException('Email ou numéro de téléphone invalide');
    }

    const profile = isEmail
      ? await this.findProfileByEmail(normalized)
      : await this.findProfileByPhone(normalized);

    // An archived profile cannot log in (#878) — answered as unknown.
    if (!profile || profile.deleted_at) {
      throw new NotFoundException(
        'Aucun compte trouvé pour cet email ou téléphone',
      );
    }

    const resendCooldownKey = `${RESEND_COOLDOWN_KEY_PREFIX}${normalized}`;
    const cooldownActive = await this.redis.get(resendCooldownKey);
    if (cooldownActive) {
      throw new HttpException(
        'Veuillez attendre avant de renvoyer le code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.assertCanSendOtp(OTP_SENDS_KEY_PREFIX, normalized);

    const otp = this.generateOtp();
    this.logOtp('resend', normalized, otp);

    await this.storeOtp(
      `${OTP_KEY_PREFIX}${normalized}`,
      `${OTP_ATTEMPTS_KEY_PREFIX}${normalized}`,
      otp,
    );

    if (isEmail) {
      await this.sendOtpByEmail(
        normalized,
        otp,
        profile.first_name ?? undefined,
      );
    } else {
      await this.sendOtpByWhatsApp(normalized, otp, profile.id);
    }

    await this.redis.set(resendCooldownKey, '1', 'EX', RESEND_COOLDOWN_SECONDS);

    return { success: true };
  }

  /**
   * Checks an OTP and returns whose it was. Public because the OAuth module
   * ("Login with Rabotka") needs exactly this and must not grow a second copy:
   * a duplicated verify is a duplicated place to forget that the code has to be
   * deleted on use, and the atomic verify-and-delete below is the only thing
   * stopping one code from being spent twice.
   */
  async verifyOtpAndGetProfile(emailOrPhone: string, otp: string) {
    const normalized = this.normalize(emailOrPhone);
    const isEmail = this.isEmail(normalized);

    const matched = await this.consumeOtp(
      `${OTP_KEY_PREFIX}${normalized}`,
      `${OTP_ATTEMPTS_KEY_PREFIX}${normalized}`,
      otp,
    );

    if (!matched) {
      throw new UnauthorizedException(
        'Code de vérification invalide ou expiré',
      );
    }

    const profile = isEmail
      ? await this.findProfileByEmail(normalized)
      : await this.findProfileByPhone(normalized);

    // An archived profile cannot log in (#878) — answered as unknown.
    if (!profile || profile.deleted_at) {
      throw new NotFoundException(
        'Aucun compte trouvé pour cet email ou téléphone',
      );
    }

    return profile;
  }

  /**
   * Exchanges a one-time code from a WhatsApp link for the ordinary profile
   * session — same payload, same expiry, same `jti` revocation as OTP login.
   * The code is consumed here, so a forwarded link only ever works once.
   */
  /** Who a one-tap code is for, without spending it — see LoginLinkController. */
  peekWhatsAppCode(code: string): Promise<WhatsAppLoginGrant | null> {
    return this.whatsAppLoginLink.peek(code);
  }

  /** Spends a one-tap code without issuing anything. */
  async burnWhatsAppCode(code: string): Promise<void> {
    await this.whatsAppLoginLink.consume(code);
  }

  async loginWithWhatsAppCode(
    code: string,
  ): Promise<{ token: string; profileId: string; path: string }> {
    const grant = await this.whatsAppLoginLink.consume(code);

    if (!grant) {
      throw new UnauthorizedException('Lien de connexion invalide ou expiré');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: grant.profileId },
      select: { id: true, status: true, deleted_at: true },
    });

    // Status is re-checked at consume time: the account may have changed in
    // the hours between the message and the tap.
    //
    // The rule is `WhatsAppLoginLinkService`'s own, not a stricter one of its
    // own invention. Requiring ACTIVE here silently undid the mint side's
    // widening — PENDING_ACTIVATION could get a code and then be refused when
    // it tapped, which is why the KYC-pending card's button dead-ended on the
    // login screen even after that was supposedly fixed. Two checks that
    // disagree are worse than either alone.
    //
    // What makes this safe is not the login gate but `ActiveProfileGuard`: a
    // non-ACTIVE session can read and nothing else.
    if (!profile || profile.deleted_at || !canMintLoginCode(profile.status)) {
      throw new UnauthorizedException('Compte indisponible');
    }

    const { token } = this.issueProfileSession(profile.id);

    return { token, profileId: profile.id, path: grant.path };
  }

  /**
   * Mints a profile session token and stamps the login.
   *
   * The one place a `type: 'profile'` token is created. It was previously
   * inlined identically in `verifyOtp` and `loginWithWhatsAppCode`, and the
   * OAuth consent flow needed a third copy — three places that each have to
   * remember the `jti` (without which the token cannot be revoked, because the
   * blocklist is keyed on it) is two too many.
   */
  issueProfileSession(profileId: string): { token: string } {
    const payload = { sub: profileId, type: 'profile', jti: randomUUID() };
    this.recordProfileLogin(profileId);
    return { token: this.jwtService.sign(payload) };
  }

  /**
   * The profile a session token belongs to, or null if it does not grant one.
   *
   * Same checks as `JwtAuthGuard`, but answering rather than throwing: callers
   * here are asking "is this visitor already signed in?" on a public route,
   * where a missing or dead token is an ordinary answer and not an error.
   */
  async resolveSessionProfile(token?: string): Promise<string | null> {
    if (!token) return null;

    try {
      const payload = this.jwtService.verify<{
        sub: string;
        type?: string;
        jti?: string;
      }>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });

      // Admin and mobile-refresh tokens are signed with the same secret; only a
      // profile session token may stand in for a WhatsApp login link.
      if ((payload.type ?? 'profile') !== 'profile') return null;

      if (payload.jti) {
        const blocked = await this.redis.get(
          `${JWT_BLOCKLIST_PREFIX}${payload.jti}`,
        );
        if (blocked) return null;
      }

      return payload.sub ?? null;
    } catch {
      // Expired, tampered with, or signed by a secret we no longer use.
      return null;
    }
  }

  async verifyOtp(
    emailOrPhone: string,
    otp: string,
  ): Promise<{ success: boolean; token: string }> {
    const profile = await this.verifyOtpAndGetProfile(emailOrPhone, otp);

    const { token } = this.issueProfileSession(profile.id);

    return { success: true, token };
  }

  async verifyOtpMobile(
    emailOrPhone: string,
    otp: string,
  ): Promise<MobileTokens> {
    const profile = await this.verifyOtpAndGetProfile(emailOrPhone, otp);
    // Here rather than inside `issueMobileTokens`: that method is shared with
    // `refreshMobileTokens`, and a rotation is not a fresh login.
    this.recordProfileLogin(profile.id);
    return this.issueMobileTokens(profile.id);
  }

  async refreshMobileTokens(refreshToken: string): Promise<MobileTokens> {
    let payload: { sub?: string; type?: string; jti?: string };
    try {
      payload = this.jwtService.verify<{
        sub?: string;
        type?: string;
        jti?: string;
      }>(refreshToken);
    } catch {
      throw new UnauthorizedException('Refresh token invalide ou expiré');
    }

    if (payload.type !== 'refresh' || !payload.jti || !payload.sub) {
      throw new UnauthorizedException('Refresh token invalide');
    }

    const redisKey = `${MOBILE_REFRESH_PREFIX}${payload.jti}`;
    const storedProfileId = await this.redis.get(redisKey);
    if (!storedProfileId || storedProfileId !== payload.sub) {
      throw new UnauthorizedException('Refresh token révoqué ou déjà utilisé');
    }

    await this.redis.del(redisKey);

    const profile = await this.prisma.profile.findUnique({
      where: { id: payload.sub },
      select: { id: true, deleted_at: true },
    });
    // Archived since the last rotation: no new tokens (#878).
    if (!profile || profile.deleted_at) {
      throw new UnauthorizedException('Compte introuvable');
    }

    return this.issueMobileTokens(profile.id);
  }

  async logoutMobile(
    accessToken: string | undefined,
    refreshToken?: string,
  ): Promise<void> {
    if (accessToken) {
      await this.revokeToken(accessToken);
    }

    if (!refreshToken) return;

    try {
      const payload = this.jwtService.decode(refreshToken);
      if (payload?.jti) {
        await this.redis.del(`${MOBILE_REFRESH_PREFIX}${payload.jti}`);
      }
    } catch {
      // Refresh token already invalid — nothing to revoke.
    }
  }

  /**
   * A bearer session (access + rotating refresh token) for a profile that has
   * just proven who it is some other way — a sign-up's verified code. The same
   * pair the mobile login hands out, so `mobile/refresh` and `mobile/logout`
   * work on it. For clients that keep tokens themselves rather than the API's
   * cookie: the mobile app, and rabotka-business's server-side session routes.
   */
  issueBearerSession(profileId: string): Promise<MobileTokens> {
    return this.issueMobileTokens(profileId);
  }

  private async issueMobileTokens(profileId: string): Promise<MobileTokens> {
    const accessToken = this.jwtService.sign(
      { sub: profileId, type: 'profile', jti: randomUUID() },
      {
        expiresIn: this.configService.get<string>(
          'JWT_ACCESS_EXPIRES_IN',
          '15m',
        ) as JwtExpiresIn,
      },
    );

    const refreshJti = randomUUID();
    const refreshToken = this.jwtService.sign(
      { sub: profileId, type: 'refresh', jti: refreshJti },
      {
        expiresIn: this.configService.get<string>(
          'JWT_REFRESH_EXPIRES_IN',
          '24h',
        ) as JwtExpiresIn,
      },
    );

    const decoded = this.jwtService.decode(refreshToken);
    const ttl = decoded?.exp
      ? decoded.exp - Math.floor(Date.now() / 1000)
      : DEFAULT_REFRESH_TTL_SECONDS;
    await this.redis.set(
      `${MOBILE_REFRESH_PREFIX}${refreshJti}`,
      profileId,
      'EX',
      Math.max(ttl, 1),
    );

    const user = await this.getMobileSessionUser(profileId);
    return { token: accessToken, refreshToken, user };
  }

  private async getMobileSessionUser(
    profileId: string,
  ): Promise<MobileSessionUser> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        phone: true,
        avatar_url: true,
        profile_type: true,
        description: true,
        categories: {
          select: { category: { select: { id: true, name: true } } },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException('Compte introuvable');
    }

    const { categories, ...rest } = profile;
    return {
      ...rest,
      domains: categories.map((pc) => pc.category),
    };
  }

  async sendAdminOtp(email: string): Promise<{ success: boolean }> {
    const normalized = this.normalize(email);

    if (!this.isEmail(normalized)) {
      throw new BadRequestException('Adresse email invalide');
    }

    const user = await this.findUserByEmail(normalized);

    if (!user) {
      throw new NotFoundException('Aucun administrateur trouvé pour cet email');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Ce compte administrateur est inactif');
    }

    await this.assertCanSendOtp(ADMIN_OTP_SENDS_KEY_PREFIX, normalized);

    const otp = this.generateOtp();

    await this.storeOtp(
      `${ADMIN_OTP_KEY_PREFIX}${normalized}`,
      `${ADMIN_OTP_ATTEMPTS_KEY_PREFIX}${normalized}`,
      otp,
    );

    await this.sendOtpByEmail(normalized, otp, user.first_name ?? undefined);

    return { success: true };
  }

  async resendAdminOtp(email: string): Promise<{ success: boolean }> {
    const normalized = this.normalize(email);

    if (!this.isEmail(normalized)) {
      throw new BadRequestException('Adresse email invalide');
    }

    const user = await this.findUserByEmail(normalized);

    if (!user) {
      throw new NotFoundException('Aucun administrateur trouvé pour cet email');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Ce compte administrateur est inactif');
    }

    const resendCooldownKey = `${ADMIN_RESEND_COOLDOWN_KEY_PREFIX}${normalized}`;
    const cooldownActive = await this.redis.get(resendCooldownKey);
    if (cooldownActive) {
      throw new HttpException(
        'Veuillez attendre avant de renvoyer le code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.assertCanSendOtp(ADMIN_OTP_SENDS_KEY_PREFIX, normalized);

    const otp = this.generateOtp();
    this.logger.debug(`[Admin OTP resend] generated for ${normalized}`);

    await this.storeOtp(
      `${ADMIN_OTP_KEY_PREFIX}${normalized}`,
      `${ADMIN_OTP_ATTEMPTS_KEY_PREFIX}${normalized}`,
      otp,
    );
    await this.redis.set(resendCooldownKey, '1', 'EX', RESEND_COOLDOWN_SECONDS);

    await this.sendOtpByEmail(normalized, otp, user.first_name ?? undefined);

    return { success: true };
  }

  async verifyAdminOtp(
    email: string,
    otp: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ): Promise<{ success: boolean; token: string; totpRequired?: boolean }> {
    const normalized = this.normalize(email);

    if (!this.isEmail(normalized)) {
      throw new BadRequestException('Adresse email invalide');
    }

    const matched = await this.consumeOtp(
      `${ADMIN_OTP_KEY_PREFIX}${normalized}`,
      `${ADMIN_OTP_ATTEMPTS_KEY_PREFIX}${normalized}`,
      otp,
    );

    if (!matched) {
      throw new UnauthorizedException(
        'Code de vérification invalide ou expiré',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
      select: { id: true, is_active: true, totp_enabled: true },
    });

    if (!user) {
      throw new NotFoundException('Aucun administrateur trouvé pour cet email');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Ce compte administrateur est inactif');
    }

    if (user.totp_enabled) {
      const pendingToken = randomUUID();
      await this.redis.set(
        `${TOTP_PENDING_PREFIX}${pendingToken}`,
        user.id,
        'EX',
        TOTP_PENDING_TTL,
      );
      return { success: true, token: pendingToken, totpRequired: true };
    }

    const payload = { sub: user.id, type: 'admin', jti: randomUUID() };
    const token = this.signAdminSession(payload);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    });
    await this.recordAdminLogin(user.id, 'otp', meta);

    return { success: true, token };
  }

  /**
   * An admin session token, with the admin lifetime rather than the profile
   * one — see `adminSessionHours`. Every admin login path goes through here.
   */
  private signAdminSession(payload: {
    sub: string;
    type: string;
    jti: string;
  }): string {
    return this.jwtService.sign(payload, {
      expiresIn: `${adminSessionHours(this.configService)}h`,
    });
  }

  async getAdminById(userId: string): Promise<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    phonePairedAt: string | null;
    phoneName: string | null;
    totpEnabled: boolean;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
        phone_paired_at: true,
        phone_name: true,
        totp_enabled: true,
      },
    });
    if (!user) {
      throw new NotFoundException('Aucun administrateur trouvé pour cet email');
    }
    return {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      phonePairedAt: user.phone_paired_at?.toISOString() ?? null,
      phoneName: user.phone_name ?? null,
      totpEnabled: user.totp_enabled,
    };
  }

  async updateAdminById(
    userId: string,
    firstName: string,
    lastName: string,
  ): Promise<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
  }> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { first_name: firstName, last_name: lastName },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        email: true,
        role: true,
      },
    });
    return {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
    };
  }

  /**
   * Stores a freshly issued code, with a clean slate of guesses: the counter
   * belongs to the code it was counting against, not to the identifier.
   */
  private async storeOtp(
    otpKey: string,
    attemptsKey: string,
    otp: string,
  ): Promise<void> {
    await storeOtp(this.redis, otpKey, attemptsKey, otp);
  }

  /** True when the guess matches; the code is spent either way it ends. */
  private async consumeOtp(
    otpKey: string,
    attemptsKey: string,
    otp: string,
  ): Promise<boolean> {
    // With the day-long lockout on top of the per-code limit (#885).
    return consumeOtpWithLockout(this.redis, otpKey, attemptsKey, otp);
  }

  /**
   * Refuses once an identifier has been sent `OTP_MAX_SENDS` codes in the
   * window. Counted per identifier, not per IP: many of our users share one
   * carrier address, and the thing being protected is the account.
   */
  private async assertCanSendOtp(
    prefix: string,
    identifier: string,
  ): Promise<void> {
    await assertCanSendOtp(this.redis, `${prefix}${identifier}`);
  }

  /**
   * Prints a live OTP to the logs — on a developer's machine only (see
   * `mayLogSecretsLocally`: it fails closed, so an environment missing
   * `NODE_ENV` or `IS_PROD` logs nothing).
   *
   * This existed unconditionally, which meant every code Rabotka has ever sent
   * is sitting in the production log stream next to the phone number it was
   * sent to. Anyone who can read logs could sign in as anyone; log shipping,
   * log search and log retention all inherit that.
   *
   * Kept for local development because the alternative is waiting on a real
   * WhatsApp delivery for every login while working offline, and that is a real
   * cost.
   */
  private logOtp(stage: 'send' | 'resend', identifier: string, otp: string) {
    if (!mayLogSecretsLocally(this.configService)) return;
    this.logger.warn(`[OTP][${stage}] ${identifier} → ${otp}`);
  }

  /** A developer's machine: `NODE_ENV=development`, and never production. */
  private isLocalDevelopment(): boolean {
    return mayLogSecretsLocally(this.configService);
  }

  private normalize(value: string): string {
    return value.trim().toLowerCase();
  }

  private isEmail(value: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(value);
  }

  private isPhone(value: string): boolean {
    const phoneRegex = /^\+?\d{8,15}$/;
    return phoneRegex.test(value.replaceAll(/\s/g, ''));
  }

  /**
   * `randomInt`, not `Math.random`.
   *
   * `Math.random` is a PRNG seeded per process and is not required to be
   * unpredictable — given enough observed outputs its internal state is
   * recoverable, and from there every subsequent OTP is. That was already the
   * wrong primitive for a credential; it became indefensible when these codes
   * started standing behind "Login with Rabotka", where one guessed OTP is an
   * account takeover on somebody else's platform. Same reasoning, and same
   * fix, as the note in `referral/utils/referral-code.util.ts`.
   */
  private generateOtp(): string {
    return generateOtp();
  }

  private async findProfileByEmail(email: string) {
    return this.prisma.profile.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        phone: true,
        first_name: true,
        deleted_at: true,
      },
    });
  }

  private async findProfileByPhone(phone: string) {
    return this.prisma.profile.findUnique({
      where: { phone },
      select: {
        id: true,
        email: true,
        phone: true,
        first_name: true,
        whatsapp_connected: true,
        deleted_at: true,
      },
    });
  }

  private async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        is_active: true,
        first_name: true,
      },
    });
  }

  private async sendOtpByEmail(
    email: string,
    otp: string,
    first_name: string,
  ): Promise<void> {
    await this.mailService.sendMail({
      to: email,
      subject: 'Votre code de vérification Rabotka',
      html: await this.layoutService.wrap(sendOtpEmail(otp, first_name), {
        previewText: `Votre code de vérification Rabotka : ${otp}`,
      }),
    });
    this.logger.log(`OTP email sent to ${email}`);
  }

  /**
   * `profileId` is passed so the code appears in the conversation history.
   * Without it the login code was the one message a moderator could never see
   * having been sent — and it is the one users most often call about.
   */
  private async sendOtpByWhatsApp(
    phone: string,
    otp: string,
    profileId?: string,
  ): Promise<void> {
    // On a developer's machine every login was a paid WhatsApp template. The
    // code is already in the terminal (logOtp), so the message is skipped.
    // The develop server runs NODE_ENV=production, so its testers still get
    // real codes; production never reaches this branch either way.
    if (this.isLocalDevelopment()) {
      this.logger.warn(
        `[OTP] WhatsApp not sent in local development — use the code logged above for ${phone}`,
      );
      return;
    }
    const sent = await this.whatsAppService.sendTemplateMessage(
      phone,
      'otp',
      otp,
      profileId,
    );
    if (!sent) {
      this.logger.error(
        `WhatsApp failed to send OTP to ${phone}; user would not receive the code`,
      );
      throw new ServiceUnavailableException(
        "Impossible d'envoyer le code de vérification par WhatsApp. Veuillez réessayer dans quelques instants.",
      );
    }
    this.logger.log(`WhatsApp OTP sent to ${phone}`);
  }

  private readonly QR_TTL = 300;
  private readonly qrKey = (id: string) => `admin:qr:${id}`;
  private readonly qrConfirmAttemptKey = (sessionId: string) =>
    `admin:qr:attempts:${sessionId}`;

  async initQrSession(): Promise<{
    sessionId: string;
    consumeNonce: string;
    qrUrl: string;
    expiresIn: number;
  }> {
    const sessionId = crypto.randomUUID();
    const consumeNonce = crypto.randomUUID();
    await this.redis.set(
      this.qrKey(sessionId),
      JSON.stringify({ status: 'pending', consumeNonce }),
      'EX',
      this.QR_TTL,
    );
    const base = this.configService
      .get<string>('ADMIN_BASE_URL', '')
      .trim()
      .replace(/\/+$/, '');
    const qrUrl = `${base}/auth/qr-confirm?session=${sessionId}`;
    return { sessionId, consumeNonce, qrUrl, expiresIn: this.QR_TTL };
  }

  async pollQrSession(
    sessionId: string,
  ): Promise<{ status: 'pending' | 'confirmed' | 'expired' }> {
    const raw = await this.redis.get(this.qrKey(sessionId));
    if (!raw) return { status: 'expired' };
    const data = JSON.parse(raw) as { status: string };
    return { status: data.status as 'pending' | 'confirmed' };
  }

  async confirmQrSession(
    sessionId: string,
    phoneToken: string,
  ): Promise<{ success: boolean }> {
    const attemptsKey = this.qrConfirmAttemptKey(sessionId);
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) {
      await this.redis.expire(attemptsKey, this.QR_TTL);
    }
    if (attempts > 5) {
      throw new HttpException(
        'Too many confirmation attempts for this QR session.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const raw = await this.redis.get(this.qrKey(sessionId));
    if (!raw) throw new UnauthorizedException('QR session expired');

    const data = JSON.parse(raw) as { status: string; consumeNonce?: string };
    if (data.status !== 'pending') {
      throw new UnauthorizedException('QR session already used');
    }

    let payload: { sub: string; type: string; pairedAt?: number; iat?: number };
    try {
      payload = this.jwtService.verify(phoneToken);
    } catch {
      throw new UnauthorizedException('Phone token invalid or expired');
    }
    if (payload.type !== 'admin-phone') {
      throw new UnauthorizedException('Invalid phone token type');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        is_active: true,
        phone_paired_at: true,
        totp_enabled: true,
      },
    });
    if (!user?.is_active) {
      throw new UnauthorizedException('Admin account not found or inactive');
    }
    if (
      !user.phone_paired_at ||
      !isCurrentPairing(payload, user.phone_paired_at)
    ) {
      throw new UnauthorizedException(
        'Phone pairing has been reset. Please re-pair your phone.',
      );
    }

    if (user.totp_enabled) {
      const pendingToken = randomUUID();
      await this.redis.set(
        `${TOTP_PENDING_PREFIX}${pendingToken}`,
        user.id,
        'EX',
        TOTP_PENDING_TTL,
      );
      await this.redis.set(
        this.qrKey(sessionId),
        JSON.stringify({
          status: 'confirmed',
          totpRequired: true,
          pendingToken,
          consumeNonce: data.consumeNonce,
        }),
        'EX',
        60,
      );
      return { success: true };
    }

    const jwtPayload = { sub: user.id, type: 'admin', jti: randomUUID() };
    const token = this.signAdminSession(jwtPayload);

    await this.redis.set(
      this.qrKey(sessionId),
      JSON.stringify({
        status: 'confirmed',
        token,
        consumeNonce: data.consumeNonce,
      }),
      'EX',
      60,
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    });
    await this.recordAdminLogin(user.id, 'qr');

    return { success: true };
  }

  async consumeQrSession(
    sessionId: string,
    consumeNonce: string,
  ): Promise<{
    token?: string;
    totpRequired?: boolean;
    pendingToken?: string;
  }> {
    const raw = await this.redis.get(this.qrKey(sessionId));
    if (!raw) throw new UnauthorizedException('QR session expired');

    const data = JSON.parse(raw) as {
      status: string;
      token?: string;
      totpRequired?: boolean;
      pendingToken?: string;
      consumeNonce?: string;
    };
    if (data.consumeNonce !== consumeNonce) {
      throw new UnauthorizedException('Invalid consume nonce');
    }
    if (data.status !== 'confirmed') {
      throw new UnauthorizedException('QR session not confirmed yet');
    }

    await this.redis.del(this.qrKey(sessionId));

    if (data.totpRequired && data.pendingToken) {
      return { totpRequired: true, pendingToken: data.pendingToken };
    }

    if (!data.token) throw new UnauthorizedException('QR session invalid');
    return { token: data.token };
  }

  private readonly PAIR_TTL = 300;
  private pairOtpKey = (userId: string) => `admin:pair:otp:${userId}`;
  private pairCooldownKey = (userId: string) => `admin:pair:resend:${userId}`;
  private pairAttemptKey = (userId: string) => `admin:pair:attempts:${userId}`;

  /**
   * Blocklists a token's jti until it would have expired.
   *
   * Verified, not just decoded (pentest A2-NV10, #886): logout is public, and
   * a decoded-only token let anyone write blocklist keys of their choosing —
   * any jti, any expiry year — into Redis. Only our own signature counts; an
   * expired one is fine (it simply writes nothing), the TTL is clamped to the
   * longest session we issue, and the jti must look like the uuids we mint.
   */
  async revokeToken(token: string): Promise<void> {
    try {
      const payload = this.jwtService.verify<{
        jti?: string;
        exp?: number;
        sub?: string;
        type?: string;
      }>(token, { ignoreExpiration: true });
      if (payload?.sub) {
        this.endSession(
          payload.type === 'admin' ? 'admin' : 'profile',
          payload.sub,
        );
      }
      if (!payload?.jti || !payload.exp || !UUID_RE.test(payload.jti)) return;
      const ttl = Math.min(
        payload.exp - Math.floor(Date.now() / 1000),
        MAX_REVOCATION_TTL_SECONDS,
      );
      if (ttl > 0) {
        await this.redis.set(
          `${JWT_BLOCKLIST_PREFIX}${payload.jti}`,
          '1',
          'EX',
          ttl,
        );
      }
    } catch {
      // Not ours, malformed: nothing to revoke, and nothing is written.
    }
  }

  /** The person's open sockets close with the session (#864). */
  private endSession(kind: 'profile' | 'admin', id: string): void {
    this.events?.emit(SESSION_ENDED, { kind, id } satisfies SessionEndedEvent);
  }

  async unpairPhone(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { phone_paired_at: null, phone_name: null },
    });
    await this.redis.del(this.pairOtpKey(userId));
    await this.redis.del(this.pairAttemptKey(userId));
  }

  async generatePhonePairingOtp(
    userId: string,
    phoneName: string,
  ): Promise<{ otp: string; expiresIn: number; userId: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, is_active: true, totp_enabled: true },
    });
    if (!user?.is_active) {
      throw new UnauthorizedException('Admin account not found or inactive');
    }
    if (!user.totp_enabled) {
      throw new BadRequestException(
        'Two-factor authentication must be enabled before pairing a phone.',
      );
    }

    const cooldown = await this.redis.get(this.pairCooldownKey(userId));
    if (cooldown) {
      const ttl = await this.redis.ttl(this.pairCooldownKey(userId));
      throw new HttpException(
        ttl > 0
          ? `Veuillez attendre ${ttl}s avant de générer un nouveau code`
          : 'Veuillez attendre avant de générer un nouveau code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const otp = this.generateOtp();

    await this.prisma.user.update({
      where: { id: userId },
      data: { phone_paired_at: null, phone_name: null },
    });

    await this.redis.set(
      this.pairOtpKey(userId),
      JSON.stringify({ otp, phoneName }),
      'EX',
      this.PAIR_TTL,
    );
    await this.redis.set(this.pairCooldownKey(userId), '1', 'EX', 60);

    return { otp, expiresIn: this.PAIR_TTL, userId };
  }

  async verifyPhonePairingOtp(
    userId: string,
    otp: string,
  ): Promise<{ token: string }> {
    const attemptsKey = this.pairAttemptKey(userId);
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) {
      await this.redis.expire(attemptsKey, this.PAIR_TTL);
    }
    if (attempts > 10) {
      throw new HttpException(
        'Too many incorrect attempts. Please generate a new pairing code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const raw = await this.redis.get(this.pairOtpKey(userId));
    if (!raw)
      throw new UnauthorizedException('Pairing code expired or invalid');

    const stored = JSON.parse(raw) as { otp: string; phoneName: string };
    if (stored.otp !== otp) {
      throw new UnauthorizedException('Pairing code incorrect');
    }

    await this.redis.del(attemptsKey);

    await this.redis.del(this.pairOtpKey(userId));

    // The pairing time is both the column and a claim: a token is only good
    // for the pairing that issued it (#868).
    const pairedAt = new Date();
    const token = this.jwtService.sign(
      {
        sub: userId,
        type: 'admin-phone',
        phoneName: stored.phoneName,
        pairedAt: pairedAt.getTime(),
      },
      { expiresIn: '7d' },
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phone_paired_at: pairedAt,
        phone_name: stored.phoneName,
      },
    });

    return { token };
  }

  // ── TOTP ──────────────────────────────────────────────────────────────────

  async setupTotp(
    userId: string,
  ): Promise<{ secret: string; qrDataUrl: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, totp_enabled: true },
    });
    if (!user) throw new NotFoundException('Admin not found');
    if (user.totp_enabled) {
      throw new BadRequestException('TOTP is already enabled');
    }

    const secret = otplib.generateSecret();
    const otpauthUrl = otplib.generateURI({
      secret,
      label: `Rabotka Admin:${user.email}`,
      issuer: 'Rabotka Admin',
      algorithm: 'sha1',
      digits: 6,
      period: 30,
    });
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);

    await this.redis.set(
      `${REDIS_KEY_PREFIX}admin:totp:setup:${userId}`,
      secret,
      'EX',
      600,
    );

    return { secret, qrDataUrl };
  }

  async enableTotp(
    userId: string,
    code: string,
  ): Promise<{ success: boolean }> {
    const pendingSecret = await this.redis.get(
      `${REDIS_KEY_PREFIX}admin:totp:setup:${userId}`,
    );
    if (!pendingSecret) {
      throw new BadRequestException(
        'No pending TOTP setup found. Start setup again.',
      );
    }

    const { valid } = await otplib.verify({
      token: code,
      secret: pendingSecret,
    });
    if (!valid) {
      throw new UnauthorizedException('Invalid TOTP code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { totp_secret: pendingSecret, totp_enabled: true },
    });
    await this.redis.del(`${REDIS_KEY_PREFIX}admin:totp:setup:${userId}`);

    return { success: true };
  }

  async disableTotp(
    userId: string,
    code: string,
  ): Promise<{ success: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totp_secret: true, totp_enabled: true },
    });
    if (!user?.totp_enabled || !user.totp_secret) {
      throw new BadRequestException('TOTP is not enabled');
    }

    const { valid } = await otplib.verify({
      token: code,
      secret: user.totp_secret,
    });
    if (!valid) {
      throw new UnauthorizedException('Invalid TOTP code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totp_secret: null,
        totp_enabled: false,
        phone_paired_at: null,
        phone_name: null,
      },
    });

    return { success: true };
  }

  async verifyTotpLogin(
    pendingToken: string,
    code: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ): Promise<{ success: boolean; token: string }> {
    const userId = await this.redis.get(
      `${TOTP_PENDING_PREFIX}${pendingToken}`,
    );
    if (!userId) {
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totp_secret: true, totp_enabled: true, is_active: true },
    });

    if (!user?.totp_enabled || !user.totp_secret) {
      throw new UnauthorizedException('TOTP not configured');
    }
    if (!user.is_active) {
      throw new UnauthorizedException('Ce compte administrateur est inactif');
    }

    const { valid } = await otplib.verify({
      token: code,
      secret: user.totp_secret,
    });
    if (!valid) {
      // The pending token is what a guesser holds, so it is what gets used up:
      // after the limit it is gone and they are back to needing the email code.
      const attemptsKey = `${TOTP_ATTEMPTS_PREFIX}${pendingToken}`;
      const attempts = await this.redis.incr(attemptsKey);
      if (attempts === 1) {
        await this.redis.expire(attemptsKey, TOTP_PENDING_TTL);
      }
      if (attempts >= TOTP_MAX_ATTEMPTS) {
        await this.redis.del(
          `${TOTP_PENDING_PREFIX}${pendingToken}`,
          attemptsKey,
        );
      }
      throw new UnauthorizedException('Invalid authenticator code');
    }

    await this.redis.del(
      `${TOTP_PENDING_PREFIX}${pendingToken}`,
      `${TOTP_ATTEMPTS_PREFIX}${pendingToken}`,
    );

    const payload = { sub: userId, type: 'admin', jti: randomUUID() };
    const token = this.signAdminSession(payload);

    await this.prisma.user.update({
      where: { id: userId },
      data: { last_login_at: new Date() },
    });
    await this.recordAdminLogin(userId, 'totp', meta);

    return { success: true, token };
  }
}
