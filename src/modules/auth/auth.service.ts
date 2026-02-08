import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../../common/services/redis/redis.constants';
import { PrismaService } from '../../common/services/prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { sendOtpEmail } from '../mail/templates';

const OTP_TTL_SECONDS = 300; // 5 minutes
const OTP_KEY_PREFIX = 'otp:';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(REDIS_CONNECTION)
    private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Send OTP to email or phone (WhatsApp mock for phone)
   */
  async sendOtp(emailOrPhone: string): Promise<{ success: boolean }> {
    const normalized = this.normalize(emailOrPhone);
    const isEmail = this.isEmail(normalized);
    const isPhone = this.isPhone(normalized);

    if (!isEmail && !isPhone) {
      throw new BadRequestException('auth.errors.invalid_email_or_phone');
    }

    // Find profile by email or phone
    const profile = await this.findProfileByEmailOrPhone(normalized, isEmail);

    if (!profile) {
      throw new NotFoundException('auth.errors.profile_not_found');
    }

    // Generate 6-digit numeric OTP
    const otp = this.generateOtp();

    // Store in Redis with TTL
    const redisKey = `${OTP_KEY_PREFIX}${normalized}`;
    await this.redis.set(redisKey, otp, 'EX', OTP_TTL_SECONDS);

    // Send OTP via email or WhatsApp (mock)
    if (isEmail) {
      await this.sendOtpByEmail(normalized, otp);
    } else {
      this.sendOtpByWhatsApp(normalized, otp);
    }

    return { success: true };
  }

  /**
   * Verify OTP and return JWT token for cookie
   */
  async verifyOtp(
    emailOrPhone: string,
    otp: string,
  ): Promise<{ success: boolean; token: string }> {
    const normalized = this.normalize(emailOrPhone);
    const isEmail = this.isEmail(normalized);

    // Get OTP from Redis
    const redisKey = `${OTP_KEY_PREFIX}${normalized}`;
    const storedOtp = await this.redis.get(redisKey);

    if (!storedOtp || storedOtp !== otp) {
      throw new UnauthorizedException('auth.errors.invalid_or_expired_otp');
    }

    // Find profile
    const profile = await this.findProfileByEmailOrPhone(normalized, isEmail);

    if (!profile) {
      throw new NotFoundException('auth.errors.profile_not_found');
    }

    // Delete OTP from Redis (single use)
    await this.redis.del(redisKey);

    // Sign JWT
    const payload = { sub: profile.id };
    const token = this.jwtService.sign(payload);

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
    // Accept phone numbers with + prefix and digits
    const phoneRegex = /^\+?[0-9]{8,15}$/;
    return phoneRegex.test(value.replace(/\s/g, ''));
  }

  private generateOtp(): string {
    // Generate 6 numeric digits (100000-999999)
    const otp = Math.floor(100000 + Math.random() * 900000);
    return otp.toString();
  }

  private async findProfileByEmailOrPhone(
    normalized: string,
    isEmail: boolean,
  ) {
    if (isEmail) {
      return this.prisma.profile.findUnique({
        where: { email: normalized },
        select: { id: true, email: true, phone: true },
      });
    } else {
      return this.prisma.profile.findUnique({
        where: { phone: normalized },
        select: { id: true, email: true, phone: true },
      });
    }
  }

  private async sendOtpByEmail(email: string, otp: string): Promise<void> {
    await this.mailService.sendMail({
      to: email,
      subject: 'Votre code de vérification Rabotka',
      html: sendOtpEmail(otp),
    });
    this.logger.log(`OTP email sent to ${email}`);
  }

  private sendOtpByWhatsApp(phone: string, otp: string): void {
    // Mock implementation - just log the OTP
    this.logger.log(`[MOCK] WhatsApp OTP for ${phone}: ${otp}`);
  }
}
