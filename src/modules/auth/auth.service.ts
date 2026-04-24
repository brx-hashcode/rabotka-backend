import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { sendOtpEmail } from '../mail/templates';
import { otpMessage } from '../whatsapp/templates';

const OTP_TTL_SECONDS = 300;
const OTP_KEY_PREFIX = 'otp:';
const ADMIN_OTP_KEY_PREFIX = 'admin:otp:';
const RESEND_COOLDOWN_SECONDS = 60;
const RESEND_COOLDOWN_KEY_PREFIX = 'otp:resend:';
const ADMIN_RESEND_COOLDOWN_KEY_PREFIX = 'admin:otp:resend:';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
    private readonly whatsAppService: WhatsAppService,
    private readonly configService: ConfigService,
  ) {}

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

    if (isPhone) {
      const phoneProfile = profile as unknown as {
        id: string;
        email: string;
        phone: string;
        whatsapp_connected: boolean;
      };
      if (!phoneProfile.whatsapp_connected) {
        throw new BadRequestException(
          "Ce numéro WhatsApp n'est pas encore vérifié. Veuillez utiliser votre adresse e-mail pour continuer.",
        );
      }
    }

    const otp = this.generateOtp();

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

    if (isPhone) {
      const phoneProfile = profile as unknown as {
        id: string;
        email: string;
        phone: string;
        whatsapp_connected: boolean;
      };
      if (!phoneProfile.whatsapp_connected) {
        throw new BadRequestException(
          "Ce numéro WhatsApp n'est pas encore vérifié. Veuillez utiliser votre adresse e-mail pour continuer.",
        );
      }
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
    this.logger.log(`[OTP resend] : ${otp}`);

    const redisKey = `${OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);
    await this.redis.set(resendCooldownKey, '1', 'EX', RESEND_COOLDOWN_SECONDS);

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

  async verifyOtp(
    emailOrPhone: string,
    otp: string,
  ): Promise<{ success: boolean; token: string }> {
    const normalized = this.normalize(emailOrPhone);
    const isEmail = this.isEmail(normalized);

    const redisKey = `${OTP_KEY_PREFIX}${normalized}`;
    const storedOtp = await this.redis.get(redisKey);

    if (!storedOtp || storedOtp !== otp) {
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

    await this.redis.del(redisKey);

    const payload = { sub: profile.id, type: 'profile' };
    const token = this.jwtService.sign(payload);

    return { success: true, token };
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
    this.logger.log(`[Admin OTP resend] : ${otp}`);

    const redisKey = `${ADMIN_OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);
    await this.redis.set(resendCooldownKey, '1', 'EX', RESEND_COOLDOWN_SECONDS);

    await this.sendOtpByEmail(normalized, otp, user.first_name ?? undefined);

    return { success: true };
  }

  async verifyAdminOtp(
    email: string,
    otp: string,
  ): Promise<{ success: boolean; token: string }> {
    const normalized = this.normalize(email);

    if (!this.isEmail(normalized)) {
      throw new BadRequestException('Adresse email invalide');
    }

    const redisKey = `${ADMIN_OTP_KEY_PREFIX}${normalized}`;
    const storedOtp = await this.redis.get(redisKey);

    if (!storedOtp || storedOtp !== otp) {
      throw new UnauthorizedException(
        'Code de vérification invalide ou expiré',
      );
    }

    const user = await this.findUserByEmail(normalized);

    if (!user) {
      throw new NotFoundException('Aucun administrateur trouvé pour cet email');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('Ce compte administrateur est inactif');
    }

    await this.redis.del(redisKey);

    const payload = { sub: user.id, type: 'admin' };
    const token = this.jwtService.sign(payload);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    });

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
      html: sendOtpEmail(otp, first_name),
    });
    this.logger.log(`OTP email sent to ${email}`);
  }

  private async sendOtpByWhatsApp(phone: string, otp: string): Promise<void> {
    const message = otpMessage(otp);
    const sent = await this.whatsAppService.sendTextMessage(phone, message);
    if (sent) {
      this.logger.log(`WhatsApp OTP sent to ${phone}`);
    } else {
      this.logger.warn(
        `WhatsApp not connected or failed to send OTP to ${phone}; user may not receive the code`,
      );
    }
  }

  // ─── QR Login ────────────────────────────────────────────────────────────────

  private readonly QR_TTL = 300;
  private qrKey = (id: string) => `admin:qr:${id}`;

  async initQrSession(): Promise<{
    sessionId: string;
    qrUrl: string;
    expiresIn: number;
  }> {
    const sessionId = crypto.randomUUID();
    await this.redis.set(
      this.qrKey(sessionId),
      JSON.stringify({ status: 'pending' }),
      'EX',
      this.QR_TTL,
    );
    const base = this.configService
      .get<string>('ADMIN_BASE_URL', '')
      .trim()
      .replace(/\/+$/, '');
    const qrUrl = `${base}/auth/qr-confirm?session=${sessionId}`;
    return { sessionId, qrUrl, expiresIn: this.QR_TTL };
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
    const raw = await this.redis.get(this.qrKey(sessionId));
    if (!raw) throw new UnauthorizedException('QR session expired');

    const data = JSON.parse(raw) as { status: string };
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
      select: { id: true, is_active: true, phone_paired_at: true },
    });
    if (!user || !user.is_active) {
      throw new UnauthorizedException('Admin account not found or inactive');
    }
    if (!user.phone_paired_at) {
      throw new UnauthorizedException('Phone pairing has been reset. Please re-pair your phone.');
    }

    const jwtPayload = { sub: user.id, type: 'admin' };
    const token = this.jwtService.sign(jwtPayload);

    await this.redis.set(
      this.qrKey(sessionId),
      JSON.stringify({ status: 'confirmed', token }),
      'EX',
      60,
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    });

    return { success: true };
  }

  async consumeQrSession(sessionId: string): Promise<{ token: string }> {
    const raw = await this.redis.get(this.qrKey(sessionId));
    if (!raw) throw new UnauthorizedException('QR session expired');

    const data = JSON.parse(raw) as { status: string; token?: string };
    if (data.status !== 'confirmed' || !data.token) {
      throw new UnauthorizedException('QR session not confirmed yet');
    }

    await this.redis.del(this.qrKey(sessionId));
    return { token: data.token };
  }

  // ─── Phone Pairing ───────────────────────────────────────────────────────────

  private readonly PAIR_TTL = 300;
  private pairOtpKey = (userId: string) => `admin:pair:otp:${userId}`;
  private pairCooldownKey = (userId: string) => `admin:pair:resend:${userId}`;

  async generatePhonePairingOtp(
    userId: string,
    phoneName: string,
  ): Promise<{ otp: string; expiresIn: number; userId: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, is_active: true },
    });
    if (!user || !user.is_active) {
      throw new UnauthorizedException('Admin account not found or inactive');
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

    // Clear existing pairing so old phone token is immediately invalidated
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
    const raw = await this.redis.get(this.pairOtpKey(userId));
    if (!raw) throw new UnauthorizedException('Pairing code expired or invalid');

    const stored = JSON.parse(raw) as { otp: string; phoneName: string };
    if (stored.otp !== otp) {
      throw new UnauthorizedException('Pairing code incorrect');
    }

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
}
