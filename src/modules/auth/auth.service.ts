import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { AccountStatus } from '@prisma/client';

import { REDIS_KEY_PREFIX, REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { LayoutService } from '../mail/layout.service';
import { LogService } from '../log/log.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { sendOtpEmail } from '../mail/templates';
import { WHATSAPP_TEMPLATES } from '../../common/constants/whatsapp-templates';
import { WhatsAppLoginLinkService } from './whatsapp-login-link.service';
import * as otplib from 'otplib';
import * as QRCode from 'qrcode';

const JWT_BLOCKLIST_PREFIX = `${REDIS_KEY_PREFIX}jwtblocklist:`;

const TOTP_PENDING_PREFIX = `${REDIS_KEY_PREFIX}admin:totp:pending:`;
const TOTP_PENDING_TTL = 300;

const OTP_TTL_SECONDS = 300;
const OTP_KEY_PREFIX = `${REDIS_KEY_PREFIX}otp:`;
const MOBILE_REFRESH_PREFIX = `${REDIS_KEY_PREFIX}mobile:refresh:`;
const DEFAULT_REFRESH_TTL_SECONDS = 24 * 60 * 60;
const ADMIN_OTP_KEY_PREFIX = `${REDIS_KEY_PREFIX}admin:otp:`;
const RESEND_COOLDOWN_SECONDS = 60;
const RESEND_COOLDOWN_KEY_PREFIX = `${REDIS_KEY_PREFIX}otp:resend:`;
const ADMIN_RESEND_COOLDOWN_KEY_PREFIX = `${REDIS_KEY_PREFIX}admin:otp:resend:`;

const LUA_VERIFY_AND_DELETE_OTP = `
local v = redis.call('GET', KEYS[1])
if v == false then return 0 end
if v == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

type JwtExpiresIn = `${number}${'s' | 'm' | 'h' | 'd'}` | `${number}`;

export interface MobileSessionUser {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
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

    if (!profile) {
      throw new NotFoundException(
        'Aucun compte trouvé pour cet email ou téléphone',
      );
    }

    const otp = this.generateOtp();

    this.logger.warn(`[OTP][send] ${normalized} → ${otp}`);

    const redisKey = `${OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);

    if (isEmail) {
      await this.sendOtpByEmail(
        normalized,
        otp,
        profile.first_name ?? undefined,
      );
    } else {
      await this.sendOtpByWhatsApp(normalized, otp);
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

    if (!profile) {
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

    const otp = this.generateOtp();
    this.logger.warn(`[OTP][resend] ${normalized} → ${otp}`);

    const redisKey = `${OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);

    if (isEmail) {
      await this.sendOtpByEmail(
        normalized,
        otp,
        profile.first_name ?? undefined,
      );
    } else {
      await this.sendOtpByWhatsApp(normalized, otp);
    }

 
    await this.redis.set(resendCooldownKey, '1', 'EX', RESEND_COOLDOWN_SECONDS);

    return { success: true };
  }


  private async verifyOtpAndGetProfile(emailOrPhone: string, otp: string) {
    const normalized = this.normalize(emailOrPhone);
    const isEmail = this.isEmail(normalized);

    const redisKey = `${OTP_KEY_PREFIX}${normalized}`;
    const matched = await this.redis.eval(
      LUA_VERIFY_AND_DELETE_OTP,
      1,
      redisKey,
      otp,
    );

    if (matched !== 1) {
      throw new UnauthorizedException(
        'Code de vérification invalide ou expiré',
      );
    }

    const profile = isEmail
      ? await this.findProfileByEmail(normalized)
      : await this.findProfileByPhone(normalized);

    if (!profile) {
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
  async loginWithWhatsAppCode(
    code: string,
  ): Promise<{ token: string; profileId: string; path: string }> {
    const grant = await this.whatsAppLoginLink.consume(code);

    if (!grant) {
      throw new UnauthorizedException('Lien de connexion invalide ou expiré');
    }

    const profile = await this.prisma.profile.findUnique({
      where: { id: grant.profileId },
      select: { id: true, status: true },
    });

    // Status is re-checked at consume time: the account may have been
    // suspended in the hours between the message and the tap.
    if (!profile || profile.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedException('Compte indisponible');
    }

    const payload = { sub: profile.id, type: 'profile', jti: randomUUID() };

    return {
      token: this.jwtService.sign(payload),
      profileId: profile.id,
      path: grant.path,
    };
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

    const payload = { sub: profile.id, type: 'profile', jti: randomUUID() };
    const token = this.jwtService.sign(payload);

    return { success: true, token };
  }


  async verifyOtpMobile(
    emailOrPhone: string,
    otp: string,
  ): Promise<MobileTokens> {
    const profile = await this.verifyOtpAndGetProfile(emailOrPhone, otp);
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
      throw new UnauthorizedException(
        'Refresh token révoqué ou déjà utilisé',
      );
    }

    await this.redis.del(redisKey);

    const profile = await this.prisma.profile.findUnique({
      where: { id: payload.sub },
      select: { id: true },
    });
    if (!profile) {
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
      const payload = this.jwtService.decode(refreshToken) as {
        jti?: string;
      } | null;
      if (payload?.jti) {
        await this.redis.del(`${MOBILE_REFRESH_PREFIX}${payload.jti}`);
      }
    } catch {
        // Refresh token already invalid — nothing to revoke.
    }
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

    const decoded = this.jwtService.decode(refreshToken) as {
      exp?: number;
    } | null;
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

    const otp = this.generateOtp();

    const redisKey = `${ADMIN_OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);

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

    const otp = this.generateOtp();
    this.logger.debug(`[Admin OTP resend] generated for ${normalized}`);

    const redisKey = `${ADMIN_OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);
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

    const redisKey = `${ADMIN_OTP_KEY_PREFIX}${normalized}`;
    const matched = await this.redis.eval(
      LUA_VERIFY_AND_DELETE_OTP,
      1,
      redisKey,
      otp,
    );

    if (matched !== 1) {
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
    const token = this.jwtService.sign(payload);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    });
    await this.recordAdminLogin(user.id, 'otp', meta);

    return { success: true, token };
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

  private generateOtp(): string {
    const otp = Math.floor(100000 + Math.random() * 900000);
    return otp.toString();
  }

  private async findProfileByEmail(email: string) {
    return this.prisma.profile.findUnique({
      where: { email },
      select: { id: true, email: true, phone: true, first_name: true },
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

  private async sendOtpByWhatsApp(phone: string, otp: string): Promise<void> {
    const template = WHATSAPP_TEMPLATES.otp;
    const sent = await this.whatsAppService.sendTemplateMessage(
      phone,
      'otp',
      otp,
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

    let payload: { sub: string; type: string };
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
    if (!user.phone_paired_at) {
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
    const token = this.jwtService.sign(jwtPayload);

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

  async revokeToken(token: string): Promise<void> {
    try {
      const payload = this.jwtService.decode(token);
      if (!payload?.jti || !payload.exp) return;
      const ttl = payload.exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) {
        await this.redis.set(
          `${JWT_BLOCKLIST_PREFIX}${payload.jti}`,
          '1',
          'EX',
          ttl,
        );
      }
    } catch {
      // Ignore decode errors — token is already invalid
    }
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

    const token = this.jwtService.sign(
      { sub: userId, type: 'admin-phone', phoneName: stored.phoneName },
      { expiresIn: '7d' },
    );

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phone_paired_at: new Date(),
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
      throw new UnauthorizedException('Invalid authenticator code');
    }

    await this.redis.del(`${TOTP_PENDING_PREFIX}${pendingToken}`);

    const payload = { sub: userId, type: 'admin', jti: randomUUID() };
    const token = this.jwtService.sign(payload);

    await this.prisma.user.update({
      where: { id: userId },
      data: { last_login_at: new Date() },
    });
    await this.recordAdminLogin(userId, 'totp', meta);

    return { success: true, token };
  }
}
