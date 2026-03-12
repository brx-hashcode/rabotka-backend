import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../../common/services/prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';

const PROFILE_ID = 'profile-uuid-1';
const USER_ID = 'user-uuid-1';

const mockProfile = {
  id: PROFILE_ID,
  email: 'user@example.com',
  phone: '+24200000001',
  whatsapp_connected: true,
};

const mockUser = {
  id: USER_ID,
  email: 'admin@example.com',
  is_active: true,
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: jest.Mocked<PrismaService>;
  let jwtService: jest.Mocked<JwtService>;
  let mailService: jest.Mocked<MailService>;
  let whatsAppService: jest.Mocked<WhatsAppService>;
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const mockPrismaService = {
      profile: { findUnique: jest.fn() },
      user: { findUnique: jest.fn(), update: jest.fn() },
    };

    const mockJwtService = {
      sign: jest.fn().mockReturnValue('jwt-token-abc'),
    };

    const mockMailService = {
      sendMail: jest.fn().mockResolvedValue({ jobId: 'job-1' }),
    };

    const mockWhatsAppService = {
      sendTextMessage: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: MailService, useValue: mockMailService },
        { provide: WhatsAppService, useValue: mockWhatsAppService },
        { provide: REDIS_CONNECTION, useValue: redis },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get(PrismaService);
    jwtService = module.get(JwtService);
    mailService = module.get(MailService);
    whatsAppService = module.get(WhatsAppService);
  });

  describe('sendOtp()', () => {
    it('sends OTP email when email is provided and profile exists', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockProfile);

      const result = await service.sendOtp('user@example.com');

      expect(result.success).toBe(true);
      expect(mailService.sendMail).toHaveBeenCalled();
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('otp:'),
        expect.any(String),
        'EX',
        300,
      );
    });

    it('sends OTP via WhatsApp when phone is provided and WhatsApp is connected', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockProfile);

      const result = await service.sendOtp('+24200000001');

      expect(result.success).toBe(true);
      expect(whatsAppService.sendTextMessage).toHaveBeenCalled();
    });

    it('throws BadRequestException for invalid email/phone', async () => {
      await expect(service.sendOtp('not-valid')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException when profile not found', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.sendOtp('user@example.com')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when phone is not WhatsApp-connected', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        ...mockProfile,
        whatsapp_connected: false,
      });

      await expect(service.sendOtp('+24200000001')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('resendOtp()', () => {
    it('resends OTP and sets cooldown', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockProfile);
      redis.get.mockResolvedValue(null); // no cooldown

      const result = await service.resendOtp('user@example.com');

      expect(result.success).toBe(true);
      expect(redis.set).toHaveBeenCalledTimes(2); // OTP + cooldown
    });

    it('throws 429 when cooldown is active', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockProfile);
      redis.get.mockResolvedValue('1'); // cooldown active

      await expect(service.resendOtp('user@example.com')).rejects.toThrow(
        HttpException,
      );
    });

    it('throws NotFoundException when profile not found', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.resendOtp('user@example.com')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('verifyOtp()', () => {
    it('returns token when OTP matches', async () => {
      redis.get.mockResolvedValue('123456');
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockProfile);

      const result = await service.verifyOtp('user@example.com', '123456');

      expect(result.success).toBe(true);
      expect(result.token).toBe('jwt-token-abc');
      expect(redis.del).toHaveBeenCalled();
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: PROFILE_ID,
        type: 'profile',
      });
    });

    it('throws UnauthorizedException when OTP does not match', async () => {
      redis.get.mockResolvedValue('111111');

      await expect(
        service.verifyOtp('user@example.com', '999999'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when OTP expired (null in redis)', async () => {
      redis.get.mockResolvedValue(null);

      await expect(
        service.verifyOtp('user@example.com', '123456'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('sendAdminOtp()', () => {
    it('sends OTP email to admin', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.sendAdminOtp('admin@example.com');

      expect(result.success).toBe(true);
      expect(mailService.sendMail).toHaveBeenCalled();
    });

    it('throws BadRequestException for non-email input', async () => {
      await expect(service.sendAdminOtp('not-an-email')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException when admin not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.sendAdminOtp('admin@example.com')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws UnauthorizedException when admin is inactive', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...mockUser,
        is_active: false,
      });

      await expect(service.sendAdminOtp('admin@example.com')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('verifyAdminOtp()', () => {
    it('returns token and updates last_login_at when OTP matches', async () => {
      redis.get.mockResolvedValue('654321');
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prisma.user.update as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.verifyAdminOtp('admin@example.com', '654321');

      expect(result.success).toBe(true);
      expect(result.token).toBe('jwt-token-abc');
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: USER_ID,
        type: 'admin',
      });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { last_login_at: expect.any(Date) },
        }),
      );
    });

    it('throws UnauthorizedException when admin OTP does not match', async () => {
      redis.get.mockResolvedValue('111111');

      await expect(
        service.verifyAdminOtp('admin@example.com', '999999'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when admin is inactive', async () => {
      redis.get.mockResolvedValue('654321');
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...mockUser,
        is_active: false,
      });

      await expect(
        service.verifyAdminOtp('admin@example.com', '654321'),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('getAdminById()', () => {
    it('returns admin info', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: USER_ID,
        email: 'admin@example.com',
        first_name: 'John',
        last_name: 'Doe',
      });

      const result = await service.getAdminById(USER_ID);

      expect(result.id).toBe(USER_ID);
      expect(result.name).toBe('John Doe');
    });

    it('throws NotFoundException when admin not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getAdminById(USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('resendAdminOtp()', () => {
    it('resends admin OTP', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      redis.get.mockResolvedValue(null);

      const result = await service.resendAdminOtp('admin@example.com');

      expect(result.success).toBe(true);
    });

    it('throws 429 when cooldown is active', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      redis.get.mockResolvedValue('1');

      await expect(service.resendAdminOtp('admin@example.com')).rejects.toThrow(
        HttpException,
      );
    });
  });
});
