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
import { LayoutService } from '../../mail/layout.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { REDIS_CONNECTION } from '../../../common/services/redis/redis.constants';
import { ConfigService } from '@nestjs/config';

jest.mock('otplib', () => ({
  generateSecret: jest.fn().mockReturnValue('MYSECRET'),
  generateURI: jest.fn().mockReturnValue('otpauth://totp/...'),
  verify: jest.fn().mockResolvedValue({ valid: true }),
  generateToken: jest.fn().mockReturnValue('123456'),
}));

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
  let redis: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    eval: jest.Mock;
    incr: jest.Mock;
    expire: jest.Mock;
    ttl: jest.Mock;
  };

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      ttl: jest.fn().mockResolvedValue(30),
    } as any;

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
        {
          provide: LayoutService,
          useValue: { wrap: jest.fn().mockImplementation((html: string) => Promise.resolve(html)) },
        },
        { provide: WhatsAppService, useValue: mockWhatsAppService },
        { provide: REDIS_CONNECTION, useValue: redis },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
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

    it('throws BadRequestException for invalid email/phone format', async () => {
      await expect(service.resendOtp('not-valid')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('resends OTP via WhatsApp for phone', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockProfile);
      redis.get.mockResolvedValue(null);
      const result = await service.resendOtp('+24200000001');
      expect(result.success).toBe(true);
      expect(whatsAppService.sendTextMessage).toHaveBeenCalled();
    });

    it('throws when phone is not WhatsApp-connected on resend', async () => {
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue({
        ...mockProfile,
        whatsapp_connected: false,
      });
      redis.get.mockResolvedValue(null);
      await expect(service.resendOtp('+24200000001')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('verifyOtp()', () => {
    it('returns token when OTP matches', async () => {
      redis.eval.mockResolvedValue(1);
      (prisma.profile.findUnique as jest.Mock).mockResolvedValue(mockProfile);

      const result = await service.verifyOtp('user@example.com', '123456');

      expect(result.success).toBe(true);
      expect(result.token).toBe('jwt-token-abc');
      expect(redis.eval).toHaveBeenCalled();
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: PROFILE_ID, type: 'profile' }),
      );
    });

    it('throws UnauthorizedException when OTP does not match', async () => {
      redis.eval.mockResolvedValue(0);

      await expect(
        service.verifyOtp('user@example.com', '999999'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when OTP expired (null in redis)', async () => {
      redis.eval.mockResolvedValue(0);

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
      redis.eval.mockResolvedValue(1);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);
      (prisma.user.update as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.verifyAdminOtp(
        'admin@example.com',
        '654321',
      );

      expect(result.success).toBe(true);
      expect(result.token).toBe('jwt-token-abc');
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: USER_ID, type: 'admin' }),
      );
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { last_login_at: expect.any(Date) },
        }),
      );
    });

    it('throws UnauthorizedException when admin OTP does not match', async () => {
      redis.eval.mockResolvedValue(0);

      await expect(
        service.verifyAdminOtp('admin@example.com', '999999'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when admin is inactive', async () => {
      redis.eval.mockResolvedValue(1);
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
      expect(result.firstName).toBe('John');
      expect(result.lastName).toBe('Doe');
      expect(result.email).toBe('admin@example.com');
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

    it('throws BadRequestException for invalid email', async () => {
      await expect(service.resendAdminOtp('notanemail')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException when admin not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(service.resendAdminOtp('admin@example.com')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws UnauthorizedException when admin is inactive', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...mockUser,
        is_active: false,
      });
      await expect(service.resendAdminOtp('admin@example.com')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('updateAdminById()', () => {
    it('updates and returns admin info', async () => {
      (prisma.user.update as jest.Mock).mockResolvedValue({
        id: USER_ID,
        email: 'admin@example.com',
        first_name: 'John',
        last_name: 'Doe',
        role: 'ADMIN',
      });
      const result = await service.updateAdminById(USER_ID, 'John', 'Doe');
      expect(result.firstName).toBe('John');
    });
  });

  describe('revokeToken()', () => {
    beforeEach(() => {
      (service as any).jwtService = { decode: jest.fn(), sign: jest.fn() };
    });

    it('stores JTI in blocklist', async () => {
      (service as any).jwtService.decode = jest.fn().mockReturnValue({
        jti: 'jti-1',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      await service.revokeToken('some-token');
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('jti-1'),
        '1',
        'EX',
        expect.any(Number),
      );
    });

    it('does nothing when token has no JTI', async () => {
      (service as any).jwtService.decode = jest
        .fn()
        .mockReturnValue({ exp: 9999 });
      await expect(service.revokeToken('some-token')).resolves.not.toThrow();
    });

    it('swallows decode errors', async () => {
      (service as any).jwtService.decode = jest.fn().mockImplementation(() => {
        throw new Error('bad');
      });
      await expect(service.revokeToken('bad-token')).resolves.not.toThrow();
    });
  });

  describe('pollQrSession()', () => {
    it('returns expired when no session found', async () => {
      redis.get.mockResolvedValueOnce(null);
      const result = await service.pollQrSession('session-1');
      expect(result.status).toBe('expired');
    });

    it('returns status from redis', async () => {
      redis.get.mockResolvedValueOnce(JSON.stringify({ status: 'pending' }));
      const result = await service.pollQrSession('session-1');
      expect(result.status).toBe('pending');
    });
  });

  describe('initQrSession()', () => {
    it('returns session data', async () => {
      // Ensure configService.get returns a string
      const configSvc = (service as any).configService;
      configSvc.get = jest.fn().mockReturnValue('http://localhost:3000');
      const result = await service.initQrSession();
      expect(result).toMatchObject({
        sessionId: expect.any(String),
        consumeNonce: expect.any(String),
        qrUrl: expect.any(String),
        expiresIn: 300,
      });
    });
  });

  describe('unpairPhone()', () => {
    it('unpairs phone and cleans redis', async () => {
      (prisma.user.update as jest.Mock).mockResolvedValue({});
      await service.unpairPhone(USER_ID);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { phone_paired_at: null, phone_name: null },
        }),
      );
    });
  });

  describe('verifyAdminOtp() with TOTP enabled', () => {
    it('returns totpRequired when TOTP is enabled', async () => {
      redis.eval.mockResolvedValueOnce(1);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...mockUser,
        totp_enabled: true,
      });
      const result = await service.verifyAdminOtp(
        'admin@example.com',
        '123456',
      );
      expect(result.totpRequired).toBe(true);
      expect(result.token).toBeDefined();
    });

    it('throws NotFoundException when user not found after OTP match', async () => {
      redis.eval.mockResolvedValueOnce(1);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      await expect(
        service.verifyAdminOtp('admin@example.com', '123456'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for invalid email format', async () => {
      await expect(
        service.verifyAdminOtp('notanemail', '123456'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('confirmQrSession()', () => {
    const validUser = {
      id: USER_ID,
      is_active: true,
      phone_paired_at: new Date(),
      totp_enabled: false,
    };

    beforeEach(() => {
      redis.incr.mockResolvedValue(1);
      (jwtService as any).verify = jest
        .fn()
        .mockReturnValue({ sub: USER_ID, type: 'admin-phone' });
    });

    it('throws when too many attempts', async () => {
      redis.incr.mockResolvedValue(6);
      let error: any;
      try {
        await service.confirmQrSession('s-1', 'phone-tok');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(429);
    });

    it('throws UnauthorizedException when session expired', async () => {
      redis.get.mockResolvedValueOnce(null);
      let error: any;
      try {
        await service.confirmQrSession('s-1', 'phone-tok');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('throws UnauthorizedException when session already used', async () => {
      redis.get.mockResolvedValueOnce(JSON.stringify({ status: 'confirmed' }));
      let error: any;
      try {
        await service.confirmQrSession('s-1', 'phone-tok');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('throws when phone token is invalid', async () => {
      redis.get.mockResolvedValueOnce(JSON.stringify({ status: 'pending' }));
      (jwtService as any).verify = jest.fn().mockImplementation(() => {
        throw new Error('invalid');
      });
      let error: any;
      try {
        await service.confirmQrSession('s-1', 'bad-token');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('throws when token type is wrong', async () => {
      redis.get.mockResolvedValueOnce(JSON.stringify({ status: 'pending' }));
      (jwtService as any).verify = jest
        .fn()
        .mockReturnValue({ sub: USER_ID, type: 'wrong-type' });
      let error: any;
      try {
        await service.confirmQrSession('s-1', 'phone-tok');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('throws when user not found or inactive', async () => {
      redis.get.mockResolvedValueOnce(JSON.stringify({ status: 'pending' }));
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      let error: any;
      try {
        await service.confirmQrSession('s-1', 'phone-tok');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('throws when phone not paired', async () => {
      redis.get.mockResolvedValueOnce(JSON.stringify({ status: 'pending' }));
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...validUser,
        phone_paired_at: null,
      });
      let error: any;
      try {
        await service.confirmQrSession('s-1', 'phone-tok');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('returns success when all valid (no TOTP)', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ status: 'pending', consumeNonce: 'n-1' }),
      );
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(validUser);
      (prisma.user.update as jest.Mock).mockResolvedValue(validUser);
      const result = await service.confirmQrSession('s-1', 'phone-tok');
      expect(result.success).toBe(true);
    });

    it('returns success with totp pending when TOTP enabled', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ status: 'pending', consumeNonce: 'n-1' }),
      );
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        ...validUser,
        totp_enabled: true,
      });
      const result = await service.confirmQrSession('s-1', 'phone-tok');
      expect(result.success).toBe(true);
    });
  });

  describe('generatePhonePairingOtp()', () => {
    it('throws when user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      let error: any;
      try {
        await service.generatePhonePairingOtp(USER_ID, 'MyPhone');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('throws when TOTP not enabled', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: USER_ID,
        is_active: true,
        totp_enabled: false,
      });
      let error: any;
      try {
        await service.generatePhonePairingOtp(USER_ID, 'MyPhone');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });

    it('throws when in cooldown', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: USER_ID,
        is_active: true,
        totp_enabled: true,
      });
      redis.get.mockResolvedValueOnce('1'); // cooldown set
      let error: any;
      try {
        await service.generatePhonePairingOtp(USER_ID, 'MyPhone');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(429);
    });

    it('returns otp when all valid', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: USER_ID,
        is_active: true,
        totp_enabled: true,
      });
      redis.get.mockResolvedValueOnce(null); // no cooldown
      (prisma.user.update as jest.Mock).mockResolvedValue({});
      const result = await service.generatePhonePairingOtp(USER_ID, 'MyPhone');
      expect(result.otp).toBeDefined();
      expect(result.userId).toBe(USER_ID);
    });
  });

  describe('verifyPhonePairingOtp()', () => {
    it('throws when too many attempts', async () => {
      redis.incr.mockResolvedValue(11);
      let error: any;
      try {
        await service.verifyPhonePairingOtp(USER_ID, '123456');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(429);
    });

    it('throws when otp not found in redis', async () => {
      redis.get.mockResolvedValueOnce(null);
      let error: any;
      try {
        await service.verifyPhonePairingOtp(USER_ID, '123456');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('throws when otp incorrect', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ otp: '654321', phoneName: 'Phone' }),
      );
      let error: any;
      try {
        await service.verifyPhonePairingOtp(USER_ID, '123456');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('returns token when otp correct', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ otp: '123456', phoneName: 'Phone' }),
      );
      (prisma.user.update as jest.Mock).mockResolvedValue({});
      const result = await service.verifyPhonePairingOtp(USER_ID, '123456');
      expect(result.token).toBeDefined();
    });
  });

  describe('setupTotp()', () => {
    it('throws when user not found', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
      let error: any;
      try {
        await service.setupTotp(USER_ID);
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(404);
    });

    it('throws when TOTP already enabled', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        email: 'admin@test.com',
        totp_enabled: true,
      });
      let error: any;
      try {
        await service.setupTotp(USER_ID);
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });

    it('returns secret and qrDataUrl', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        email: 'admin@test.com',
        totp_enabled: false,
      });
      const result = await service.setupTotp(USER_ID);
      expect(result.secret).toBeDefined();
      expect(result.qrDataUrl).toBeDefined();
    });
  });

  describe('enableTotp()', () => {
    it('throws when no pending setup found', async () => {
      redis.get.mockResolvedValueOnce(null);
      let error: any;
      try {
        await service.enableTotp(USER_ID, '123456');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });

    it('throws when TOTP code is invalid', async () => {
      redis.get.mockResolvedValueOnce('MYSECRET');
      const otplib = require('otplib');
      otplib.verify.mockResolvedValueOnce({ valid: false });
      let error: any;
      try {
        await service.enableTotp(USER_ID, 'wrong');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('enables TOTP when code is valid', async () => {
      redis.get.mockResolvedValueOnce('MYSECRET');
      const otplib = require('otplib');
      otplib.verify.mockResolvedValueOnce({ valid: true });
      (prisma.user.update as jest.Mock).mockResolvedValue({});
      const result = await service.enableTotp(USER_ID, '123456');
      expect(result.success).toBe(true);
    });
  });

  describe('disableTotp()', () => {
    it('throws when TOTP not enabled', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        totp_secret: null,
        totp_enabled: false,
      });
      let error: any;
      try {
        await service.disableTotp(USER_ID, '123456');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });

    it('throws when TOTP code is invalid', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        totp_secret: 'SEC',
        totp_enabled: true,
      });
      const otplib = require('otplib');
      otplib.verify.mockResolvedValueOnce({ valid: false });
      let error: any;
      try {
        await service.disableTotp(USER_ID, 'wrong');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('disables TOTP when code is valid', async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        totp_secret: 'SEC',
        totp_enabled: true,
      });
      const otplib = require('otplib');
      otplib.verify.mockResolvedValueOnce({ valid: true });
      (prisma.user.update as jest.Mock).mockResolvedValue({});
      const result = await service.disableTotp(USER_ID, '123456');
      expect(result.success).toBe(true);
    });
  });

  describe('verifyTotpLogin()', () => {
    it('throws when session expired', async () => {
      redis.get.mockResolvedValueOnce(null);
      let error: any;
      try {
        await service.verifyTotpLogin('pending-tok', '123456');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('throws when TOTP not configured', async () => {
      redis.get.mockResolvedValueOnce(USER_ID);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        totp_secret: null,
        totp_enabled: false,
        is_active: true,
      });
      let error: any;
      try {
        await service.verifyTotpLogin('pending-tok', '123456');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('throws when user inactive', async () => {
      redis.get.mockResolvedValueOnce(USER_ID);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        totp_secret: 'SEC',
        totp_enabled: true,
        is_active: false,
      });
      let error: any;
      try {
        await service.verifyTotpLogin('pending-tok', '123456');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('throws when TOTP code invalid', async () => {
      redis.get.mockResolvedValueOnce(USER_ID);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        totp_secret: 'SEC',
        totp_enabled: true,
        is_active: true,
      });
      const otplib = require('otplib');
      otplib.verify.mockResolvedValueOnce({ valid: false });
      let error: any;
      try {
        await service.verifyTotpLogin('pending-tok', 'bad-code');
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(401);
    });

    it('returns token when TOTP code is valid', async () => {
      redis.get.mockResolvedValueOnce(USER_ID);
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        totp_secret: 'SEC',
        totp_enabled: true,
        is_active: true,
      });
      const otplib = require('otplib');
      otplib.verify.mockResolvedValueOnce({ valid: true });
      (prisma.user.update as jest.Mock).mockResolvedValue({});
      const result = await service.verifyTotpLogin('pending-tok', '123456');
      expect(result.token).toBeDefined();
    });
  });

  describe('consumeQrSession()', () => {
    it('throws UnauthorizedException when session expired', async () => {
      redis.get.mockResolvedValueOnce(null);
      await expect(service.consumeQrSession('s-1', 'nonce-1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when nonce mismatch', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({
          status: 'confirmed',
          consumeNonce: 'other',
          token: 'tok',
        }),
      );
      await expect(service.consumeQrSession('s-1', 'nonce-1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when not confirmed', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ status: 'pending', consumeNonce: 'nonce-1' }),
      );
      await expect(service.consumeQrSession('s-1', 'nonce-1')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('returns token on confirmed session', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({
          status: 'confirmed',
          consumeNonce: 'nonce-1',
          token: 'my-token',
        }),
      );
      const result = await service.consumeQrSession('s-1', 'nonce-1');
      expect(result.token).toBe('my-token');
    });

    it('returns totpRequired when confirmed with totp', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({
          status: 'confirmed',
          consumeNonce: 'nonce-1',
          totpRequired: true,
          pendingToken: 'pt-1',
        }),
      );
      const result = await service.consumeQrSession('s-1', 'nonce-1');
      expect(result.totpRequired).toBe(true);
      expect(result.pendingToken).toBe('pt-1');
    });
  });
});
