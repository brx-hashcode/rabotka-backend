import { ForbiddenException } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { ProfileController } from '../profile.controller';

function makeJwtService() {
  return { sign: jest.fn().mockReturnValue('mock-token') };
}

function makeConfigService() {
  return { get: jest.fn().mockReturnValue('access_token') };
}

function makeProfileService() {
  return {
    createProfile: jest.fn().mockResolvedValue({
      message: 'Profil créé avec succès',
      profileId: 'new-p-1',
      profileType: 'WORKER',
      creditedBalance: 1000,
    }),
    uploadKycFile: jest.fn().mockResolvedValue({ url: 'https://cdn/id.jpg' }),
    findById: jest.fn().mockResolvedValue({ id: 'p-1', firstName: 'Alice' }),
    getPenaltiesByProfileId: jest.fn().mockResolvedValue([]),
    updateProfile: jest.fn().mockResolvedValue({ id: 'p-1' }),
    updateAvatar: jest
      .fn()
      .mockResolvedValue({ avatarUrl: 'https://cdn/avatar.jpg' }),
    requestWhatsAppVerification: jest.fn().mockResolvedValue({ success: true }),
    getApplicationsByProfileId: jest
      .fn()
      .mockResolvedValue({ data: [], total: 0, page: 1, limit: 10 }),
  };
}

function makeMailService() {
  return { sendMail: jest.fn().mockResolvedValue(undefined) };
}

function makeLayoutService() {
  return { wrap: jest.fn().mockImplementation((html: string) => Promise.resolve(html)) };
}

function makeWalletService() {
  return {
    recordPenaltyPayment: jest
      .fn()
      .mockResolvedValue({ reference: 'RBK-2026-abc123' }),
  };
}

function makeReq(profileId = 'p-1') {
  return { user: { profileId } } as any;
}

describe('ProfileController', () => {
  let controller: ProfileController;
  let profileService: ReturnType<typeof makeProfileService>;
  let mailService: ReturnType<typeof makeMailService>;
  let walletService: ReturnType<typeof makeWalletService>;
  let whatsApp: { sendTemplateMessage: jest.Mock };
  let contactedProfiles: { listContacts: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    profileService = makeProfileService();
    mailService = makeMailService();
    walletService = makeWalletService();
    whatsApp = { sendTemplateMessage: jest.fn().mockResolvedValue(true) };
    contactedProfiles = { listContacts: jest.fn().mockResolvedValue([]) };
    controller = new ProfileController(
      profileService as any,
      mailService as any,
      makeLayoutService() as any,
      walletService as any,
      makeJwtService() as any,
      makeConfigService() as any,
      whatsApp as any,
      contactedProfiles as any,
    );
  });

  // ─── POST / ───────────────────────────────────────────────────────────────

  describe('createProfile()', () => {
    const dto = {
      firstName: 'Alice',
      lastName: 'Dupont',
      email: 'alice@example.com',
      phone: '+242000001',
      address: '10 Rue Paris',
      profileType: 'WORKER' as any,
      kycDocumentUrl: 'https://cdn/id.jpg',
      kycSelfieUrl: 'https://cdn/selfie.jpg',
    };

    const mockRes = () => ({ cookie: jest.fn() }) as any;

    it('creates a profile and sends welcome email', async () => {
      const result = await controller.createProfile(dto as any, mockRes());
      expect(profileService.createProfile).toHaveBeenCalledWith(dto);
      expect(mailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: dto.email }),
      );
      expect(result.message).toBe('Profil créé avec succès');
    });

    it('gives the new session the same lifetime as every other login', async () => {
      // Signup used to hand-roll `res.cookie` with a 24h maxAge while every
      // other path went through `setAuthCookie` and issued 30 days — so people
      // who had just signed up were logged out 29 days early.
      const res = mockRes();
      await controller.createProfile(dto as any, res);

      expect(res.cookie).toHaveBeenCalledWith(
        'access_token',
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
          path: '/',
          maxAge: 30 * 24 * 60 * 60 * 1000,
        }),
      );
    });

    it('tells the welcome email about the credit that was just granted', async () => {
      // The email is the message titled "Bienvenue" and never mentioned it.
      await controller.createProfile(dto as any, mockRes());

      expect(mailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining((1000).toLocaleString('fr-FR')),
        }),
      );
    });

    it('sends the profile_created WhatsApp template with the first name', async () => {
      await controller.createProfile(dto as any, mockRes());
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        dto.phone,
        'profileCreatedWorker',
        dto.firstName,
      );
    });

    it('still creates the profile when the WhatsApp template send fails', async () => {
      whatsApp.sendTemplateMessage.mockRejectedValueOnce(new Error('twilio'));
      await expect(
        controller.createProfile(dto as any, mockRes()),
      ).resolves.toEqual(
        expect.objectContaining({ message: 'Profil créé avec succès' }),
      );
    });
  });

  describe('uploadKyc()', () => {
    const makeFile = (): Express.Multer.File =>
      ({
        originalname: 'id.jpg',
        mimetype: 'image/jpeg',
        buffer: Buffer.from('data'),
        size: 4,
      }) as Express.Multer.File;

    it('returns the url from the service', async () => {
      profileService.uploadKycFile.mockResolvedValue({
        url: 'https://cdn/id.jpg',
      });
      const result = await controller.uploadKyc(makeFile());
      expect(profileService.uploadKycFile).toHaveBeenCalled();
      expect(result).toEqual({ url: 'https://cdn/id.jpg' });
    });

    it('throws BadRequestException when no file is provided', async () => {
      await expect(controller.uploadKyc(undefined as any)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── GET /me ─────────────────────────────────────────────────────────────

  describe('getMe()', () => {
    it('returns profile for authenticated user', async () => {
      const result = await controller.getMe(makeReq());
      expect(profileService.findById).toHaveBeenCalledWith('p-1');
      expect(result).toEqual({ id: 'p-1', firstName: 'Alice' });
    });
  });

  // ─── GET /penalties ───────────────────────────────────────────────────────

  describe('getPenalties()', () => {
    it('returns penalties for authenticated user', async () => {
      const result = await controller.getPenalties(makeReq());
      expect(profileService.getPenaltiesByProfileId).toHaveBeenCalledWith(
        'p-1',
      );
      expect(result).toEqual([]);
    });
  });

  // ─── PATCH /penalties/:id/pay ─────────────────────────────────────────────

  describe('payPenalty()', () => {
    it('records payment and returns reference', async () => {
      const result = await controller.payPenalty(makeReq(), 'pen-1', {
        paymentMethod: 'CASH',
      } as any);
      expect(walletService.recordPenaltyPayment).toHaveBeenCalledWith(
        'pen-1',
        'p-1',
        { paymentMethod: 'CASH' },
      );
      expect(result).toEqual({ success: true, reference: 'RBK-2026-abc123' });
    });
  });

  // ─── GET /applications ────────────────────────────────────────────────────

  describe('getApplications()', () => {
    it('returns paginated applications with defaults', async () => {
      const result = await controller.getApplications(makeReq());
      expect(profileService.getApplicationsByProfileId).toHaveBeenCalledWith(
        'p-1',
        1,
        10,
      );
      expect(result.data).toEqual([]);
    });

    it('parses page and limit from query params', async () => {
      await controller.getApplications(makeReq(), '2', '5');
      expect(profileService.getApplicationsByProfileId).toHaveBeenCalledWith(
        'p-1',
        2,
        5,
      );
    });

    it('clamps page to minimum 1', async () => {
      await controller.getApplications(makeReq(), '0');
      expect(profileService.getApplicationsByProfileId).toHaveBeenCalledWith(
        'p-1',
        1,
        10,
      );
    });

    it('clamps limit to maximum 100', async () => {
      await controller.getApplications(makeReq(), '1', '999');
      expect(profileService.getApplicationsByProfileId).toHaveBeenCalledWith(
        'p-1',
        1,
        100,
      );
    });

    it('defaults limit to 10 when non-numeric', async () => {
      await controller.getApplications(makeReq(), undefined, 'abc');
      expect(profileService.getApplicationsByProfileId).toHaveBeenCalledWith(
        'p-1',
        1,
        10,
      );
    });
  });

  // ─── PATCH / ─────────────────────────────────────────────────────────────

  describe('updateProfile()', () => {
    it('delegates to profileService and returns result', async () => {
      const result = await controller.updateProfile(makeReq(), {
        firstName: 'Bob',
      });
      expect(profileService.updateProfile).toHaveBeenCalledWith('p-1', {
        firstName: 'Bob',
      });
      expect(result).toEqual({ id: 'p-1' });
    });
  });

  // ─── POST /avatar ─────────────────────────────────────────────────────────

  describe('uploadAvatar()', () => {
    const avatarFile = {
      fieldname: 'avatar',
      originalname: 'avatar.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('img'),
      size: 3,
    } as Express.Multer.File;

    it('uploads avatar and returns URL', async () => {
      const result = await controller.uploadAvatar(makeReq(), avatarFile);
      expect(profileService.updateAvatar).toHaveBeenCalledWith(
        'p-1',
        avatarFile,
      );
      expect(result.avatarUrl).toBe('https://cdn/avatar.jpg');
    });

    it('throws BadRequestException when no avatar file provided', async () => {
      await expect(
        controller.uploadAvatar(makeReq(), undefined as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── POST /verify-whatsapp ────────────────────────────────────────────────

  describe('requestWhatsAppVerification()', () => {
    it('delegates to profileService using authenticated user profileId', async () => {
      const req = { user: { profileId: 'p-1' } } as any;
      const result = await controller.requestWhatsAppVerification(req);
      expect(profileService.requestWhatsAppVerification).toHaveBeenCalledWith(
        'p-1',
      );
      expect(result).toEqual({ success: true });
    });
  });

  // ─── GET /contacts ─────────────────────────────────────────────────────────

  describe('listContacts()', () => {
    it('asks only for the caller’s own contacts', async () => {
      const req = { user: { profileId: 'e-1', type: 'profile' } } as any;

      await controller.listContacts(req);

      expect(contactedProfiles.listContacts).toHaveBeenCalledWith('e-1');
    });

    it('passes the service refusal through — a worker gets no contacts', async () => {
      contactedProfiles.listContacts.mockRejectedValue(
        new ForbiddenException('Réservé aux recruteurs'),
      );
      const req = { user: { profileId: 'w-1', type: 'profile' } } as any;

      await expect(controller.listContacts(req)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
