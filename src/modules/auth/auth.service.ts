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
  ) {}

  async sendOtp(emailOrPhone: string): Promise<{ success: boolean }> {
    const normalized = this.normalize(emailOrPhone);
    const isEmail = this.isEmail(normalized);
    const isPhone = this.isPhone(normalized);

    if (!isEmail && !isPhone) {
      throw new BadRequestException('auth.errors.invalid_email_or_phone');
    }

    const profile = isEmail
      ? await this.findProfileByEmail(normalized)
      : await this.findProfileByPhone(normalized);

    if (!profile) {
      throw new NotFoundException('auth.errors.profile_not_found');
    }

    // Check WhatsApp verification if using phone number
    if (isPhone) {
      const phoneProfile = profile as {
        id: string;
        email: string;
        phone: string;
        whatsapp_connected: boolean;
      };
      if (!phoneProfile.whatsapp_connected) {
        throw new BadRequestException('auth.errors.whatsapp_not_verified');
      }
    }

    const otp = this.generateOtp();

    const redisKey = `${OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);

    if (isEmail) {
      await this.sendOtpByEmail(normalized, otp);
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
      throw new BadRequestException('auth.errors.invalid_email_or_phone');
    }

    const profile = isEmail
      ? await this.findProfileByEmail(normalized)
      : await this.findProfileByPhone(normalized);

    if (!profile) {
      throw new NotFoundException('auth.errors.profile_not_found');
    }

    // Check WhatsApp verification if using phone number
    if (isPhone) {
      const phoneProfile = profile as {
        id: string;
        email: string;
        phone: string;
        whatsapp_connected: boolean;
      };
      if (!phoneProfile.whatsapp_connected) {
        throw new BadRequestException('auth.errors.whatsapp_not_verified');
      }
    }

    const resendCooldownKey = `${RESEND_COOLDOWN_KEY_PREFIX}${normalized}`;
    const cooldownActive = await this.redis.get(resendCooldownKey);
    if (cooldownActive) {
      throw new HttpException(
        'auth.errors.resend_cooldown',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const otp = this.generateOtp();
    this.logger.log(`[OTP resend] : ${otp}`);

    const redisKey = `${OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);
    await this.redis.set(resendCooldownKey, '1', 'EX', RESEND_COOLDOWN_SECONDS);

    if (isEmail) {
      await this.sendOtpByEmail(normalized, otp);
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
      throw new UnauthorizedException('auth.errors.invalid_or_expired_otp');
    }

    const profile = isEmail
      ? await this.findProfileByEmail(normalized)
      : await this.findProfileByPhone(normalized);

    if (!profile) {
      throw new NotFoundException('auth.errors.profile_not_found');
    }

    await this.redis.del(redisKey);

    const payload = { sub: profile.id, type: 'profile' };
    const token = this.jwtService.sign(payload);

    return { success: true, token };
  }

  async sendAdminOtp(email: string): Promise<{ success: boolean }> {
    const normalized = this.normalize(email);

    if (!this.isEmail(normalized)) {
      throw new BadRequestException('auth.errors.invalid_email');
    }

    const user = await this.findUserByEmail(normalized);

    if (!user) {
      throw new NotFoundException('auth.errors.user_not_found');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('auth.errors.user_inactive');
    }

    const otp = this.generateOtp();

    const redisKey = `${ADMIN_OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);

    await this.sendOtpByEmail(normalized, otp);

    return { success: true };
  }

  async resendAdminOtp(email: string): Promise<{ success: boolean }> {
    const normalized = this.normalize(email);

    if (!this.isEmail(normalized)) {
      throw new BadRequestException('auth.errors.invalid_email');
    }

    const user = await this.findUserByEmail(normalized);

    if (!user) {
      throw new NotFoundException('auth.errors.user_not_found');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('auth.errors.user_inactive');
    }

    const resendCooldownKey = `${ADMIN_RESEND_COOLDOWN_KEY_PREFIX}${normalized}`;
    const cooldownActive = await this.redis.get(resendCooldownKey);
    if (cooldownActive) {
      throw new HttpException(
        'auth.errors.resend_cooldown',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const otp = this.generateOtp();
    this.logger.log(`[Admin OTP resend] : ${otp}`);

    const redisKey = `${ADMIN_OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);
    await this.redis.set(resendCooldownKey, '1', 'EX', RESEND_COOLDOWN_SECONDS);

    await this.sendOtpByEmail(normalized, otp);

    return { success: true };
  }

  async verifyAdminOtp(
    email: string,
    otp: string,
  ): Promise<{ success: boolean; token: string }> {
    const normalized = this.normalize(email);

    if (!this.isEmail(normalized)) {
      throw new BadRequestException('auth.errors.invalid_email');
    }

    const redisKey = `${ADMIN_OTP_KEY_PREFIX}${normalized}`;
    const storedOtp = await this.redis.get(redisKey);

    if (!storedOtp || storedOtp !== otp) {
      throw new UnauthorizedException('auth.errors.invalid_or_expired_otp');
    }

    const user = await this.findUserByEmail(normalized);

    if (!user) {
      throw new NotFoundException('auth.errors.user_not_found');
    }

    if (!user.is_active) {
      throw new UnauthorizedException('auth.errors.user_inactive');
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
      select: { id: true, email: true, phone: true },
    });
  }

  private async findProfileByPhone(phone: string) {
    return this.prisma.profile.findUnique({
      where: { phone },
      select: { id: true, email: true, phone: true, whatsapp_connected: true },
    });
  }

  private async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, is_active: true },
    });
  }

  private async sendOtpByEmail(email: string, otp: string): Promise<void> {
    await this.mailService.sendMail({
      to: email,
      subject: 'Votre code de vérification Rabotka',
      html: sendOtpEmail(otp),
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
}
