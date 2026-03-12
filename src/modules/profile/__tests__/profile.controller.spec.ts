import { BadRequestException } from '@nestjs/common';
import { ProfileController } from '../profile.controller';

function makeProfileService() {
  return {
    createProfile: jest.fn().mockResolvedValue({ message: 'Profil créé avec succès' }),
    findById: jest.fn().mockResolvedValue({ id: 'p-1', firstName: 'Alice' }),
    getPenaltiesByProfileId: jest.fn().mockResolvedValue([]),
    updateProfile: jest.fn().mockResolvedValue({ id: 'p-1' }),
    updateAvatar: jest.fn().mockResolvedValue({ avatarUrl: 'https://cdn/avatar.jpg' }),
    requestWhatsAppVerification: jest.fn().mockResolvedValue({ success: true }),
    getApplicationsByProfileId: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 10 }),
  };
}

function makeMailService() {
  return { sendMail: jest.fn().mockResolvedValue(undefined) };
}

function makeWalletService() {
  return {
    recordPenaltyPayment: jest.fn().mockResolvedValue({ reference: 'RBK-2026-abc123' }),
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

  beforeEach(() => {
    jest.clearAllMocks();
    profileService = makeProfileService();
    mailService = makeMailService();
    walletService = makeWalletService();
    controller = new ProfileController(
      profileService as any,
      mailService as any,
      walletService as any,
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
    };

    const makeFile = (name: string): Express.Multer.File =>
      ({
        fieldname: name,
        originalname: `${name}.jpg`,
        mimetype: 'image/jpeg',
        buffer: Buffer.from('data'),
        size: 4,
      }) as Express.Multer.File;

    it('creates a profile and sends welcome email', async () => {
      const result = await controller.createProfile(dto, {
        kycDocument: [makeFile('doc')],
        kycSelfie: [makeFile('selfie')],
      });
      expect(profileService.createProfile).toHaveBeenCalled();
      expect(mailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: dto.email }),
      );
      expect(result.message).toBe('Profil créé avec succès');
    });

    it('throws BadRequestException when kycDocument is missing', async () => {
      await expect(
        controller.createProfile(dto, { kycSelfie: [makeFile('selfie')] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when kycSelfie is missing', async () => {
      await expect(
        controller.createProfile(dto, { kycDocument: [makeFile('doc')] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when files object is empty', async () => {
      await expect(controller.createProfile(dto, {})).rejects.toThrow(
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
      expect(profileService.getPenaltiesByProfileId).toHaveBeenCalledWith('p-1');
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
      expect(profileService.updateAvatar).toHaveBeenCalledWith('p-1', avatarFile);
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
    it('delegates to profileService and returns success', async () => {
      const result = await controller.requestWhatsAppVerification({
        profileId: 'p-1',
      });
      expect(profileService.requestWhatsAppVerification).toHaveBeenCalledWith(
        'p-1',
      );
      expect(result).toEqual({ success: true });
    });
  });
});
