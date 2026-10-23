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
    payPenaltyFromWallet: jest
      .fn()
      .mockResolvedValue({ reference: 'RBK-2026-abc123' }),
    confirmPenaltyPaymentManually: jest.fn(),
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
  // The signup token store: one token, verified for the DTO's number.
  let redis: { get: jest.Mock; del: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    profileService = makeProfileService();
    mailService = makeMailService();
    walletService = makeWalletService();
    whatsApp = { sendTemplateMessage: jest.fn().mockResolvedValue(true) };
    contactedProfiles = { listContacts: jest.fn().mockResolvedValue([]) };
    redis = {
      get: jest.fn().mockResolvedValue('+242000001'),
      del: jest.fn().mockResolvedValue(2),
    };
    controller = new ProfileController(
      profileService as any,
      mailService as any,
      makeLayoutService() as any,
      walletService as any,
      makeJwtService() as any,
      makeConfigService() as any,
      whatsApp as any,
      contactedProfiles as any,
      redis as any,
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
      signupToken: 'verified-token',
    };

    const mockRes = () => ({ cookie: jest.fn() }) as any;

    it('refuses without a token from the signup verification', async () => {
      redis.get.mockResolvedValue(null);
      await expect(
        controller.createProfile(dto as any, mockRes()),
      ).rejects.toThrow(ForbiddenException);
      expect(profileService.createProfile).not.toHaveBeenCalled();
    });

    it("refuses a token verified for someone else's number", async () => {
      redis.get.mockResolvedValue('+242999999');
      await expect(
        controller.createProfile(dto as any, mockRes()),
      ).rejects.toThrow(ForbiddenException);
      expect(profileService.createProfile).not.toHaveBeenCalled();
    });

    it('spends the token once the profile exists', async () => {
      await controller.createProfile(dto as any, mockRes());
      expect(redis.del).toHaveBeenCalledTimes(1);
    });

    it('creates a profile and sends welcome email', async () => {
      const result = await controller.createProfile(dto as any, mockRes());
      expect(profileService.createProfile).toHaveBeenCalledWith(
        dto,
        'whatsapp',
      );
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
        expect.any(String),
      );
    });

    it('refuses a business body with a WhatsApp token', async () => {
      await expect(
        controller.createProfile(
          { ...dto, business: { name: 'X' } } as any,
          mockRes(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(profileService.createProfile).not.toHaveBeenCalled();
    });

    describe('business sign-up (token proven by email)', () => {
      const businessDto = {
        ...dto,
        email: 'contact@ecole.cg',
        profileType: 'EMPLOYER' as any,
        kycDocumentUrl: undefined,
        kycSelfieUrl: undefined,
        business: { name: 'École Les Lauriers', category: 'SCHOOL' },
      };
      beforeEach(() => {
        redis.get.mockResolvedValue(
          JSON.stringify({ entry: 'business', email: 'contact@ecole.cg' }),
        );
      });

      it('creates a business profile, welcomed by email and not on WhatsApp', async () => {
        await controller.createProfile(businessDto as any, mockRes());

        expect(profileService.createProfile).toHaveBeenCalledWith(
          businessDto,
          'business',
        );
        expect(mailService.sendMail).toHaveBeenCalledWith(
          expect.objectContaining({ to: 'contact@ecole.cg' }),
        );
        expect(whatsApp.sendTemplateMessage).not.toHaveBeenCalled();
      });

      it('refuses an email other than the one proven', async () => {
        await expect(
          controller.createProfile(
            { ...businessDto, email: 'autre@ecole.cg' } as any,
            mockRes(),
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it('refuses without the business', async () => {
        await expect(
          controller.createProfile(
            { ...businessDto, business: undefined } as any,
            mockRes(),
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('refuses a worker account', async () => {
        await expect(
          controller.createProfile(
            { ...businessDto, profileType: 'WORKER' } as any,
            mockRes(),
          ),
        ).rejects.toThrow(BadRequestException);
        expect(profileService.createProfile).not.toHaveBeenCalled();
      });
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
        // A real JPEG header: the bytes are checked against the type.
        buffer: Buffer.from([
          0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1,
        ]),
        size: 12,
      }) as Express.Multer.File;

    it('refuses a file whose bytes are not what its type claims', async () => {
      const disguised = {
        ...makeFile(),
        buffer: Buffer.from('<html><script>alert(1)</script></html>'),
      } as Express.Multer.File;
      await expect(controller.uploadKyc(disguised)).rejects.toThrow(
        BadRequestException,
      );
      expect(profileService.uploadKycFile).not.toHaveBeenCalled();
    });

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
    // Pentest A2-F05 (#861): this route used to mark the penalty paid with no
    // money moving, on the owner's say-so. It must pay from the wallet.
    it('pays from the profile wallet and returns the reference', async () => {
      const result = await controller.payPenalty(makeReq(), 'pen-1', {
        paymentMethod: 'CASH',
      } as any);
      expect(walletService.payPenaltyFromWallet).toHaveBeenCalledWith(
        'pen-1',
        'p-1',
      );
      expect(result).toEqual({ success: true, reference: 'RBK-2026-abc123' });
    });

    it('never settles a penalty without a payment', async () => {
      await controller.payPenalty(makeReq(), 'pen-1', {
        paymentMethod: 'CASH',
      } as any);
      expect(
        walletService.confirmPenaltyPaymentManually,
      ).not.toHaveBeenCalled();
    });

    it('surfaces a short balance instead of settling', async () => {
      walletService.payPenaltyFromWallet.mockRejectedValueOnce(
        new BadRequestException('Solde insuffisant pour régler cette pénalité'),
      );
      await expect(
        controller.payPenalty(makeReq(), 'pen-1', {
          paymentMethod: 'CASH',
        } as any),
      ).rejects.toThrow(BadRequestException);
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
