import { BadRequestException, Logger } from '@nestjs/common';
import { ProfileService } from '../profile.service';
import { GeoService } from '../../geo/geo.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

const baseProfile = {
  id: 'p-1',
  first_name: 'Alice',
  last_name: 'Dupont',
  email: 'alice@example.com',
  phone: '+242000001',
  address: '10 Rue Paris',
  description: 'Expert',
  profile_type: 'WORKER',
  status: 'ACTIVE',
  verification_status: 'VERIFIED',
  reliability_score: 90,
  whatsapp_connected: true,
  avatar_url: null,
  created_at: new Date(),
  updated_at: new Date(),
  verified_by: null,
  verified_at: null,
  rejection_reason: null,
  kyc_verification_note: null,
  _count: { job_offers: 0, applications: 2, penalties: 1 },
  kyc_documents: [],
  kyc_verification_images: [],
  categories: [],
  category: null,
};

function makePrisma() {
  return {
    profile: {
      findUnique: jest.fn().mockResolvedValue(baseProfile),
      update: jest.fn().mockResolvedValue(baseProfile),
      create: jest.fn().mockResolvedValue({ id: 'new-p-1' }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([baseProfile]),
    },
    penalty: {
      count: jest.fn().mockResolvedValue(0),
      // The admin list resolves unpaid-penalty counts for a whole page in one
      // grouped query rather than one count per profile.
      groupBy: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    application: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest
      .fn()
      .mockImplementation((calls) =>
        Array.isArray(calls) ? Promise.resolve(calls) : calls(makePrisma()),
      ),
    kycDocument: {
      updateMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    kycVerificationImage: {
      deleteMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    file: {
      create: jest.fn().mockResolvedValue({}),
    },
    profilePlatformDocumentLink: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    document: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      delete: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function makeFileService() {
  return {
    uploadToStorage: jest.fn().mockResolvedValue({
      url: 'https://cdn.example.com/file.jpg',
      key: 'folder/file.jpg',
      bucket: 'bucket',
      provider: 'cloudflare',
      originalFilename: 'file.jpg',
      mimeType: 'image/jpeg',
      size: 100,
    }),
  };
}

function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

function makeWhatsApp() {
  return {
    sendTextMessage: jest.fn().mockResolvedValue(true),
    sendTemplateMessage: jest.fn().mockResolvedValue(true),
    isConfigured: jest.fn().mockReturnValue(true),
  };
}

function makeConfigService() {
  return {
    get: jest.fn().mockReturnValue('http://localhost:3000'),
  };
}

function makeDocumentService() {
  return {
    fillDocumentTemplateAsPdf: jest
      .fn()
      .mockResolvedValue(Buffer.from('pdf-content')),
  };
}

describe('ProfileService', () => {
  let service: ProfileService;
  let prisma: ReturnType<typeof makePrisma>;
  let fileService: ReturnType<typeof makeFileService>;
  let redis: ReturnType<typeof makeRedis>;
  let whatsApp: ReturnType<typeof makeWhatsApp>;
  let configService: ReturnType<typeof makeConfigService>;
  let documentService: ReturnType<typeof makeDocumentService>;
  let portfolioService: { ensurePortfolioSlug: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    // Make $transaction pass the same mock instance so spies on prisma.profile.update etc. are observable
    prisma.$transaction.mockImplementation((calls: any) =>
      Array.isArray(calls) ? Promise.resolve(calls) : calls(prisma),
    );
    fileService = makeFileService();
    redis = makeRedis();
    whatsApp = makeWhatsApp();
    configService = makeConfigService();
    documentService = makeDocumentService();
    portfolioService = {
      ensurePortfolioSlug: jest.fn().mockResolvedValue('alice-dupont-a1b2c3'),
    };
    service = new ProfileService(
      prisma as any,
      fileService as any,
      redis as any,
      whatsApp as any,
      { mint: jest.fn().mockResolvedValue('login-code-1') } as any,
      configService as any,
      {} as any, // mailService
      {
        wrap: jest
          .fn()
          .mockImplementation((html: string) => Promise.resolve(html)),
      } as any, // layoutService
      { emit: jest.fn() } as any, // eventEmitter
      {
        getProfileWalletBalance: jest.fn().mockResolvedValue(0),
        grantWelcomeCredit: jest.fn().mockResolvedValue(undefined),
        getWelcomeCreditsConfig: jest.fn().mockResolvedValue({
          workerCreditFcfa: 100,
          employerCreditFcfa: 500,
        }),
        creditProfileWallet: jest.fn().mockResolvedValue(undefined),
      } as any, // walletService
      documentService as any, // documentService
      {
        indexWorkerProfile: jest.fn().mockResolvedValue(undefined),
        indexEmployerProfile: jest.fn().mockResolvedValue(undefined),
        deleteWorkerFromIndex: jest.fn().mockResolvedValue(undefined),
        deleteEmployerFromIndex: jest.fn().mockResolvedValue(undefined),
      } as any, // matchingService
      {
        ensureSeeded: jest.fn().mockResolvedValue(undefined),
      } as any, // interestClusters
      { geocode: jest.fn().mockResolvedValue(null) } as any, // geocodingService
      {
        // Pass-through: the loader always runs, so these tests keep asserting
        // real query behaviour rather than a cached value.
        wrap: (_k: string, _t: number, loader: () => unknown) => loader(),
        listKey: (e: string) => e,
        dashboardKey: (e: string) => e,
        invalidate: jest.fn(),
      } as any, // adminCache
      portfolioService as any, // portfolioService
      // The real one: it has no dependencies beyond a checked-in JSON file, so
      // mocking it would only weaken the country/city assertions below.
      new GeoService(), // geo
    );
  });

  describe('findById()', () => {
    it('returns formatted profile response', async () => {
      const result = await service.findById('p-1');
      expect(result.id).toBe('p-1');
      expect(result.firstName).toBe('Alice');
      expect(result.email).toBe('alice@example.com');
    });

    it('throws NotFoundException when profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce(null);
      await expect(service.findById('missing')).rejects.toThrow(
        'Profil non trouvé',
      );
    });
  });

  describe('updateProfile()', () => {
    it('updates profile and returns result', async () => {
      const result = await service.updateProfile('p-1', { firstName: 'Bob' });
      expect(prisma.profile.update).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('throws NotFoundException when profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce(null);
      await expect(service.updateProfile('missing', {})).rejects.toThrow(
        'Profil non trouvé',
      );
    });

    it('updates profile fields without allowing status change', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce(baseProfile);
      prisma.profile.findUnique.mockResolvedValueOnce(baseProfile);
      await service.updateProfile('p-1', { firstName: 'Bob' });
      expect(prisma.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ status: expect.anything() }),
        }),
      );
    });
  });

  describe('updateAvatar()', () => {
    const avatarFile = {
      fieldname: 'avatar',
      originalname: 'avatar.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('fake'),
      size: 4,
    } as Express.Multer.File;

    it('uploads avatar and updates profile', async () => {
      const result = await service.updateAvatar('p-1', avatarFile);
      expect(result.avatarUrl).toBe('https://cdn.example.com/file.jpg');
      expect(prisma.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { avatar_url: 'https://cdn.example.com/file.jpg' },
        }),
      );
    });

    it('throws NotFoundException when profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce(null);
      await expect(service.updateAvatar('missing', avatarFile)).rejects.toThrow(
        'Profil non trouvé',
      );
    });

    it('throws BadRequestException when no file provided', async () => {
      await expect(service.updateAvatar('p-1', null as any)).rejects.toThrow(
        'photo de profil est requise',
      );
    });
  });

  describe('getPenaltiesByProfileId()', () => {
    it('returns empty array when no penalties', async () => {
      prisma.penalty.findMany.mockResolvedValue([]);
      const result = await service.getPenaltiesByProfileId('p-1');
      expect(result).toEqual([]);
    });

    it('maps penalties to response format', async () => {
      prisma.penalty.findMany.mockResolvedValue([
        {
          id: 'pen-1',
          amount: 5000,
          reason: 'Late',
          applied_at: new Date(),
          paid_at: null,
          application_id: 'app-1',
          application: { job_offer: { title: 'Plombier' } },
        },
      ]);
      const result = await service.getPenaltiesByProfileId('p-1');
      expect(result).toHaveLength(1);
      expect(result[0].amount).toBe(5000);
      expect(result[0].jobOfferTitle).toBe('Plombier');
    });
  });

  describe('markPenaltyPaid()', () => {
    it('marks penalty as paid', async () => {
      prisma.penalty.findUnique.mockResolvedValue({
        id: 'pen-1',
        profile_id: 'p-1',
        paid_at: null,
      });
      await service.markPenaltyPaid('pen-1', 'p-1');
      expect(prisma.penalty.update).toHaveBeenCalled();
    });

    it('throws NotFoundException when penalty does not belong to profile', async () => {
      prisma.penalty.findUnique.mockResolvedValue({
        id: 'pen-1',
        profile_id: 'other',
      });
      await expect(service.markPenaltyPaid('pen-1', 'p-1')).rejects.toThrow(
        'Pénalité introuvable',
      );
    });

    it('does nothing when already paid', async () => {
      prisma.penalty.findUnique.mockResolvedValue({
        id: 'pen-1',
        profile_id: 'p-1',
        paid_at: new Date(),
      });
      await service.markPenaltyPaid('pen-1', 'p-1');
      expect(prisma.penalty.update).not.toHaveBeenCalled();
    });
  });

  describe('getApplicationsByProfileId()', () => {
    it('returns paginated applications', async () => {
      prisma.application.findMany.mockResolvedValue([
        {
          id: 'app-1',
          status: 'PENDING',
          created_at: new Date(),
          job_offer: {
            id: 'jo-1',
            title: 'Plombier',
            scheduled_at: new Date(),
            amount: 15000,
            address: '10 Rue Paris',
            status: 'ACTIVE',
          },
        },
      ]);
      prisma.application.count.mockResolvedValue(1);
      const result = await service.getApplicationsByProfileId('p-1', 1, 10);
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('getProfileDetailForAdmin()', () => {
    it('returns full admin profile detail', async () => {
      const result = await service.getProfileDetailForAdmin('p-1');
      expect(result.id).toBe('p-1');
      expect(result.kycDocuments).toBeDefined();
    });

    it('throws NotFoundException when not found', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce(null);
      await expect(service.getProfileDetailForAdmin('missing')).rejects.toThrow(
        'Profil non trouvé',
      );
    });
  });

  describe('getProfilesForAdmin()', () => {
    it('returns paginated profiles list', async () => {
      prisma.profile.count.mockResolvedValue(1);
      const result = await service.getProfilesForAdmin({ page: 1, limit: 10 });
      expect(result.data).toBeDefined();
      expect(result.total).toBe(1);
    });

    it('applies search filter', async () => {
      await service.getProfilesForAdmin({ page: 1, limit: 10, q: 'Alice' });
      expect(prisma.profile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
        }),
      );
    });

    it('applies status filter', async () => {
      await service.getProfilesForAdmin({
        page: 1,
        limit: 10,
        status: ['ACTIVE'] as any,
      });
      expect(prisma.profile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { in: ['ACTIVE'] } }),
        }),
      );
    });
  });

  describe('requestWhatsAppVerification()', () => {
    it('sends verification link and returns success', async () => {
      const result = await service.requestWhatsAppVerification('p-1');
      expect(result.success).toBe(true);
      expect(redis.set).toHaveBeenCalled();
      expect(whatsApp.sendTextMessage).toHaveBeenCalled();
    });

    it('throws NotFoundException when profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.requestWhatsAppVerification('missing'),
      ).rejects.toThrow('Profil non trouvé');
    });

    it('throws ServiceUnavailableException when WhatsApp not configured', async () => {
      whatsApp.isConfigured.mockReturnValue(false);
      await expect(service.requestWhatsAppVerification('p-1')).rejects.toThrow(
        'configuré',
      );
    });

    it('cleans up token and throws when message send fails', async () => {
      whatsApp.sendTextMessage.mockResolvedValue(null);
      await expect(service.requestWhatsAppVerification('p-1')).rejects.toThrow(
        'Échec',
      );
      expect(redis.del).toHaveBeenCalled();
    });
  });

  describe('updateProfileStatusByAdmin()', () => {
    it('updates status and returns profile detail', async () => {
      // findUnique for status check
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        status: 'PENDING_ACTIVATION',
      });
      const result = await service.updateProfileStatusByAdmin(
        'p-1',
        'ACTIVE' as any,
      );
      expect(prisma.profile.update).toHaveBeenCalled();
    });

    it('throws NotFoundException when profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.updateProfileStatusByAdmin('missing', 'ACTIVE' as any),
      ).rejects.toThrow('Profil non trouvé');
    });
  });

  describe('updateProfileByAdmin()', () => {
    it('updates and returns profile detail', async () => {
      const result = await service.updateProfileByAdmin('p-1', {
        firstName: 'Bob',
      });
      expect(prisma.profile.update).toHaveBeenCalled();
    });

    it('throws NotFoundException when not found', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce(null);
      await expect(service.updateProfileByAdmin('missing', {})).rejects.toThrow(
        'Profil non trouvé',
      );
    });

    it('throws ConflictException on P2002 with phone field (array target)', async () => {
      const { Prisma } = jest.requireActual('@prisma/client');
      const prismaError = Object.assign(
        new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: '5.0.0',
        }),
        { meta: { target: ['phone'] } },
      );
      prisma.profile.update.mockRejectedValueOnce(prismaError);
      await expect(
        service.updateProfileByAdmin('p-1', { phone: '+242' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('numéro de téléphone'),
      });
    });

    it('throws ConflictException on P2002 with email field (string target)', async () => {
      const { Prisma } = jest.requireActual('@prisma/client');
      const prismaError = Object.assign(
        new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: '5.0.0',
        }),
        { meta: { target: 'Profile_email_key' } },
      );
      prisma.profile.update.mockRejectedValueOnce(prismaError);
      await expect(
        service.updateProfileByAdmin('p-1', { email: 'x@x.com' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('email'),
      });
    });

    it('rethrows non-P2002 errors', async () => {
      prisma.profile.update.mockRejectedValueOnce(new Error('DB down'));
      await expect(service.updateProfileByAdmin('p-1', {})).rejects.toThrow(
        'DB down',
      );
    });
  });

  describe('verifyProfileKyc()', () => {
    it('verifies KYC and returns profile detail', async () => {
      const result = await service.verifyProfileKyc(
        'p-1',
        'admin-1',
        'VERIFIED',
        'Documents reviewed and match requirements.',
      );
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result.id).toBe('p-1');
    });

    it('verifies KYC with file upload', async () => {
      const file = {
        fieldname: 'files',
        originalname: 'verify.jpg',
        mimetype: 'image/jpeg',
        buffer: Buffer.from('data'),
        size: 4,
      } as Express.Multer.File;
      const result = await service.verifyProfileKyc(
        'p-1',
        'admin-1',
        'VERIFIED',
        'Approved with additional supporting images.',
        [file],
      );
      expect(fileService.uploadToStorage).toHaveBeenCalled();
      expect(result.id).toBe('p-1');
    });

    it('activates the account when KYC passes', async () => {
      // Verified is the moment the account becomes usable — leaving it
      // PENDING_ACTIVATION means the worker still cannot do anything.
      await service.verifyProfileKyc('p-1', 'admin-1', 'VERIFIED', 'Conforme.');

      expect(prisma.profile.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p-1' },
          data: expect.objectContaining({
            verification_status: 'VERIFIED',
            whatsapp_connected: true,
            status: 'ACTIVE',
          }),
        }),
      );
    });

    it('leaves the account untouched when KYC is rejected', async () => {
      await service.verifyProfileKyc('p-1', 'admin-1', 'REJECTED', 'Flou.');

      const data = prisma.profile.update.mock.calls.at(-1)?.[0].data;
      expect(data.verification_status).toBe('REJECTED');
      expect(data.whatsapp_connected).toBeUndefined();
      expect(data.status).toBeUndefined();
    });

    it('rejects KYC with a reason', async () => {
      const result = await service.verifyProfileKyc(
        'p-1',
        'admin-1',
        'REJECTED',
        'Document flou',
      );
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('throws NotFoundException when profile not found', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.verifyProfileKyc('missing', 'admin-1', 'VERIFIED', 'Note'),
      ).rejects.toThrow('Profil non trouvé');
    });
  });

  describe('uploadKycFile()', () => {
    it('uploads to the kyc-documents folder and returns the url', async () => {
      const file = {
        originalname: 'id.jpg',
        mimetype: 'image/jpeg',
        buffer: Buffer.from('id'),
        size: 2,
      } as Express.Multer.File;

      const result = await service.uploadKycFile(file);

      expect(fileService.uploadToStorage).toHaveBeenCalledWith(file, {
        folder: 'kyc-documents',
        access: 'public',
      });
      expect(result).toEqual({ url: 'https://cdn.example.com/file.jpg' });
    });
  });

  describe('createProfile()', () => {
    const dto = {
      firstName: 'Alice',
      lastName: 'Dupont',
      email: 'alice@example.com',
      phone: '+242000001',
      address: '10 Rue Paris',
      description: 'Expert',
      profileType: 'WORKER' as any,
      documentType: 'CNI' as any,
      readAndApprovedPolicies: true,
      kycDocumentUrl: 'https://cdn.example.com/id.jpg',
      kycSelfieUrl: 'https://cdn.example.com/selfie.jpg',
    };

    it('creates profile and returns success message', async () => {
      const txPrisma = makePrisma();
      txPrisma.profile.create.mockResolvedValue({ id: 'new-p-1' });
      prisma.$transaction.mockImplementation((fn: any) => fn(txPrisma));
      const result = await service.createProfile(dto);
      expect(result?.message).toContain('succès');
    });

    it('gives a new worker a portfolio slug straight away', async () => {
      // The slug used to be minted only on the first realization upload, so a
      // worker who had uploaded nothing had no public page and employers saw no
      // "Voir le portfolio" — the workers most in need of a shopfront were the
      // ones without one.
      const txPrisma = makePrisma();
      txPrisma.profile.create.mockResolvedValue({ id: 'new-p-1' });
      prisma.$transaction.mockImplementation((fn: any) => fn(txPrisma));

      await service.createProfile(dto);

      expect(portfolioService.ensurePortfolioSlug).toHaveBeenCalledWith(
        'new-p-1',
      );
    });

    it('does not mint a slug for an employer', async () => {
      // Employers have no portfolio; minting would be a pointless write and a
      // public page nobody should land on.
      const txPrisma = makePrisma();
      txPrisma.profile.create.mockResolvedValue({ id: 'new-e-1' });
      prisma.$transaction.mockImplementation((fn: any) => fn(txPrisma));

      await service.createProfile({ ...dto, profileType: 'EMPLOYER' as any });

      expect(portfolioService.ensurePortfolioSlug).not.toHaveBeenCalled();
    });

    it('still completes the signup when the slug cannot be minted', async () => {
      // A slug is a nicety; a failed signup is not. The detail endpoint mints
      // on demand later anyway.
      const txPrisma = makePrisma();
      txPrisma.profile.create.mockResolvedValue({ id: 'new-p-2' });
      prisma.$transaction.mockImplementation((fn: any) => fn(txPrisma));
      portfolioService.ensurePortfolioSlug.mockRejectedValue(new Error('boom'));

      const result = await service.createProfile(dto);

      expect(result?.message).toContain('succès');
    });

    it('marks the number as connected without activating the account', async () => {
      // The number used at signup is the one every platform message goes to,
      // so the separate linking step only re-asked for what we had. The
      // account still waits on KYC — `status` must stay PENDING_ACTIVATION.
      const txPrisma = makePrisma();
      txPrisma.profile.create.mockResolvedValue({ id: 'new-p-1' });
      prisma.$transaction.mockImplementation((fn: any) => fn(txPrisma));

      await service.createProfile(dto);

      expect(txPrisma.profile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            whatsapp_connected: true,
            status: 'PENDING_ACTIVATION',
          }),
        }),
      );
    });

    it('does not re-upload files (urls already uploaded)', async () => {
      const txPrisma = makePrisma();
      txPrisma.profile.create.mockResolvedValue({ id: 'new-p-1' });
      prisma.$transaction.mockImplementation((fn: any) => fn(txPrisma));
      await service.createProfile(dto);
      expect(fileService.uploadToStorage).not.toHaveBeenCalled();
    });
  });

  describe('updateProfile() - EMPLOYER branch', () => {
    it('calls indexEmployerProfile for EMPLOYER profile', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        profile_type: 'EMPLOYER',
      });
      await service.updateProfile('p-1', { firstName: 'Jean' });
      const matchingService = (service as any).matchingService;
      expect(matchingService.indexEmployerProfile).toHaveBeenCalledWith('p-1');
    });
  });

  describe('updateProfileByAdmin() - EMPLOYER branch', () => {
    it('calls indexEmployerProfile for EMPLOYER profile', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        profile_type: 'EMPLOYER',
      });
      await service.updateProfileByAdmin('p-1', { firstName: 'Jean' });
      const matchingService = (service as any).matchingService;
      expect(matchingService.indexEmployerProfile).toHaveBeenCalledWith('p-1');
    });
  });

  describe('updateProfileByAdmin() - profile type change', () => {
    it('removes from the old collection and indexes into the new one', async () => {
      // Existing profile is a WORKER; admin switches it to EMPLOYER.
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        profile_type: 'WORKER',
      });
      await service.updateProfileByAdmin('p-1', { profileType: 'EMPLOYER' });
      const matchingService = (service as any).matchingService;
      expect(matchingService.deleteWorkerFromIndex).toHaveBeenCalledWith('p-1');
      expect(matchingService.indexEmployerProfile).toHaveBeenCalledWith('p-1');
      expect(matchingService.indexWorkerProfile).not.toHaveBeenCalled();
      expect(matchingService.deleteEmployerFromIndex).not.toHaveBeenCalled();
    });

    it('does not delete from any collection when the type is unchanged', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        profile_type: 'WORKER',
      });
      await service.updateProfileByAdmin('p-1', { firstName: 'Jean' });
      const matchingService = (service as any).matchingService;
      expect(matchingService.deleteWorkerFromIndex).not.toHaveBeenCalled();
      expect(matchingService.deleteEmployerFromIndex).not.toHaveBeenCalled();
      expect(matchingService.indexWorkerProfile).toHaveBeenCalledWith('p-1');
    });
  });

  describe('updateProfileStatusByAdmin() - SUSPENDED branch', () => {
    const REASON = 'Trois pénalités impayées';

    it('sends suspension email carrying the reason', async () => {
      const mailService = { sendMail: jest.fn().mockResolvedValue(undefined) };
      (service as any).mailService = mailService;
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        status: 'ACTIVE',
        email: 'alice@example.com',
      });
      await service.updateProfileStatusByAdmin(
        'p-1',
        'SUSPENDED' as any,
        REASON,
      );
      expect(mailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'alice@example.com',
          html: expect.stringContaining(REASON),
        }),
      );
    });

    it('sends the suspension WhatsApp template with the reason', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        status: 'ACTIVE',
        phone: '+242000001',
      });
      await service.updateProfileStatusByAdmin(
        'p-1',
        'SUSPENDED' as any,
        REASON,
      );
      // Email alone reaches nobody when `email` is null, which it may be.
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalledWith(
        '+242000001',
        'accountSuspended',
        {
          firstName: baseProfile.first_name,
          reason: REASON,
          loginCode: 'login-code-1',
        },
        'p-1',
      );
    });

    it('persists the reason and the date on the profile', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        status: 'ACTIVE',
      });
      await service.updateProfileStatusByAdmin(
        'p-1',
        'SUSPENDED' as any,
        REASON,
      );
      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: 'p-1' },
        data: {
          status: 'SUSPENDED',
          suspension_reason: REASON,
          suspended_at: expect.any(Date),
        },
      });
    });

    it('clears the reason when the account leaves SUSPENDED', async () => {
      // A reactivated account showing why it was once suspended reads as though
      // it still is.
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        status: 'SUSPENDED',
      });
      await service.updateProfileStatusByAdmin('p-1', 'ACTIVE' as any);
      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: 'p-1' },
        data: {
          status: 'ACTIVE',
          suspension_reason: null,
          suspended_at: null,
        },
      });
    });

    it('refuses to suspend without a reason', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        status: 'ACTIVE',
      });
      await expect(
        service.updateProfileStatusByAdmin('p-1', 'SUSPENDED' as any, '   '),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.profile.update).not.toHaveBeenCalled();
    });

    it('handles suspension email failure gracefully', async () => {
      const mailService = {
        sendMail: jest.fn().mockRejectedValueOnce(new Error('mail fail')),
      };
      (service as any).mailService = mailService;
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        status: 'ACTIVE',
        email: 'alice@example.com',
      });
      await service.updateProfileStatusByAdmin(
        'p-1',
        'SUSPENDED' as any,
        REASON,
      );
      // Should not throw
    });

    it('sends activation WhatsApp when transitioning to ACTIVE', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        status: 'PENDING_ACTIVATION',
        phone: '+242000001',
      });
      await service.updateProfileStatusByAdmin('p-1', 'ACTIVE' as any);
      expect(whatsApp.sendTemplateMessage).toHaveBeenCalled();
    });

    it('handles activation notification without phone', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        status: 'PENDING_ACTIVATION',
        phone: null,
      });
      await service.updateProfileStatusByAdmin('p-1', 'ACTIVE' as any);
      // Should not throw - just skips sendTextMessage
    });
  });

  describe('getProfileDetailForAdmin() - verifiers', () => {
    it('fetches verifier names when verified_by is set', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        verified_by: 'admin-1',
        kyc_documents: [
          {
            id: 'doc-1',
            document_type: 'CNI',
            document_category: 'ID',
            document_url: 'http://x',
            storage_key: null,
            verification_status: 'VERIFIED',
            verified_at: new Date(),
            verified_by: 'admin-1',
            rejection_reason: null,
            created_at: new Date(),
          },
        ],
        kyc_verification_images: [
          {
            id: 'img-1',
            image_url: 'http://img',
            uploaded_by: 'admin-1',
            created_at: new Date(),
          },
        ],
        _count: { job_offers: 0, applications: 0, penalties: 0 },
        category: null,
        categories: [],
      });
      prisma.user.findMany.mockResolvedValue([
        { id: 'admin-1', first_name: 'Admin', last_name: 'User' },
      ]);
      (service as any).fileService.getPresignedUrlFromPublicUrl = jest
        .fn()
        .mockResolvedValue('http://presigned');
      const result = await service.getProfileDetailForAdmin('p-1');
      expect(result.verifiedBy).toBe('Admin User');
    });

    it('returns null verifiedBy when no verified_by', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        verified_by: null,
        kyc_documents: [],
        kyc_verification_images: [],
        _count: { job_offers: 0, applications: 0, penalties: 0 },
        category: null,
        categories: [],
      });
      const result = await service.getProfileDetailForAdmin('p-1');
      expect(result.verifiedBy).toBeNull();
    });

    it('returns document_url directly without file service calls', async () => {
      prisma.profile.findUnique.mockResolvedValue({
        ...baseProfile,
        verified_by: null,
        kyc_documents: [
          {
            id: 'doc-1',
            document_type: 'CNI',
            document_category: 'ID',
            document_url: 'https://storage/folder/file.jpg',
            storage_key: 'folder/file.jpg',
            verification_status: 'VERIFIED',
            verified_at: null,
            verified_by: null,
            rejection_reason: null,
            created_at: new Date(),
          },
        ],
        kyc_verification_images: [],
        _count: { job_offers: 0, applications: 0, penalties: 0 },
        category: null,
        categories: [],
      });
      const result = await service.getProfileDetailForAdmin('p-1');
      expect(result.kycDocuments[0].documentUrl).toBe(
        'https://storage/folder/file.jpg',
      );
    });
  });

  describe('createProfile() - EMPLOYER branch', () => {
    const baseDto = {
      firstName: 'Jean',
      lastName: 'Patron',
      email: 'j@x.com',
      phone: '+242',
      address: '1 Rue',
      description: 'Boss',
      documentType: 'CNI' as any,
      readAndApprovedPolicies: true,
      kycDocumentUrl: 'https://cdn.example.com/id.jpg',
      kycSelfieUrl: 'https://cdn.example.com/selfie.jpg',
    };

    it('calls indexEmployerProfile for EMPLOYER profileType', async () => {
      const txPrisma = makePrisma();
      txPrisma.profile.create.mockResolvedValue({ id: 'new-p-1' });
      prisma.$transaction.mockImplementation((fn: any) => fn(txPrisma));
      await service.createProfile({
        ...baseDto,
        profileType: 'EMPLOYER' as any,
      });
      const matchingService = (service as any).matchingService;
      expect(matchingService.indexEmployerProfile).toHaveBeenCalledWith(
        'new-p-1',
      );
    });

    it('handles P2002 conflict on phone during createProfile', async () => {
      const { Prisma } = jest.requireActual('@prisma/client');
      const prismaError = Object.assign(
        new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: '5.0.0',
        }),
        { meta: { target: ['phone'] } },
      );
      prisma.$transaction.mockRejectedValueOnce(prismaError);
      let error: any;
      try {
        await service.createProfile({
          ...baseDto,
          profileType: 'WORKER' as any,
        });
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(409);
    });

    it('handles P2002 conflict on email during createProfile', async () => {
      const { Prisma } = jest.requireActual('@prisma/client');
      const prismaError = Object.assign(
        new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: '5.0.0',
        }),
        { meta: { target: ['email'] } },
      );
      prisma.$transaction.mockRejectedValueOnce(prismaError);
      let error: any;
      try {
        await service.createProfile({
          ...baseDto,
          profileType: 'WORKER' as any,
        });
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(409);
    });

    it('handles generic error during createProfile', async () => {
      prisma.$transaction.mockRejectedValueOnce(new Error('unexpected'));
      let error: any;
      try {
        await service.createProfile({
          ...baseDto,
          profileType: 'WORKER' as any,
        });
      } catch (e) {
        error = e;
      }
      expect(error?.status).toBe(400);
    });
  });

  describe('getProfilesForAdmin() - additional filters', () => {
    it('applies profileType filter', async () => {
      await service.getProfilesForAdmin({
        page: 1,
        limit: 10,
        profileType: ['WORKER'] as any,
      });
      expect(prisma.profile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ profile_type: { in: ['WORKER'] } }),
        }),
      );
    });

    it('applies whatsappConnected filter', async () => {
      await service.getProfilesForAdmin({
        page: 1,
        limit: 10,
        whatsappConnected: true,
      });
      expect(prisma.profile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ whatsapp_connected: true }),
        }),
      );
    });

    it('applies verificationStatus filter', async () => {
      await service.getProfilesForAdmin({
        page: 1,
        limit: 10,
        verificationStatus: ['VERIFIED'] as any,
      });
      expect(prisma.profile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            verification_status: { in: ['VERIFIED'] },
          }),
        }),
      );
    });
  });

  describe('downloadAgreement()', () => {
    const template = {
      id: 'doc-1',
      title: 'Accord Plateforme',
      category: 'AGREEMENT',
      mime_type:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      created_at: new Date(),
    };
    const profile = {
      first_name: 'Alice',
      last_name: 'Dupont',
      created_at: new Date('2026-01-01T10:00:00Z'),
    };

    it('returns a PDF buffer and filename', async () => {
      prisma.document.findFirst.mockResolvedValue(template);
      prisma.profile.findUnique.mockResolvedValue(profile);
      const result = await service.downloadAgreement('p-1');
      expect(documentService.fillDocumentTemplateAsPdf).toHaveBeenCalledWith(
        'doc-1',
        expect.objectContaining({
          FIRST_NAME: 'Alice',
          LAST_NAME: 'Dupont',
          FULL_NAME: 'Alice Dupont',
        }),
      );
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.filename).toMatch(/Dupont.*\.pdf$/);
    });

    it('throws NotFoundException when no AGREEMENT template exists', async () => {
      prisma.document.findFirst.mockResolvedValue(null);
      prisma.profile.findUnique.mockResolvedValue(profile);
      await expect(service.downloadAgreement('p-1')).rejects.toThrow('accord');
    });

    it('throws NotFoundException when profile does not exist', async () => {
      prisma.document.findFirst.mockResolvedValue(template);
      prisma.profile.findUnique.mockResolvedValue(null);
      await expect(service.downloadAgreement('p-1')).rejects.toThrow('Profil');
    });

    it('returns cached buffer without calling fillDocumentTemplateAsPdf on cache hit', async () => {
      prisma.document.findFirst.mockResolvedValue(template);
      prisma.profile.findUnique.mockResolvedValue(profile);
      const cachedBuf = Buffer.from('cached-agreement');
      redis.get.mockResolvedValue(cachedBuf.toString('base64'));
      const result = await service.downloadAgreement('p-1');
      expect(documentService.fillDocumentTemplateAsPdf).not.toHaveBeenCalled();
      expect(result.buffer).toEqual(cachedBuf);
    });

    it('stores generated agreement PDF with 30-day TTL on cache miss', async () => {
      prisma.document.findFirst.mockResolvedValue(template);
      prisma.profile.findUnique.mockResolvedValue(profile);
      await service.downloadAgreement('p-1');
      expect(redis.setex).toHaveBeenCalledWith(
        expect.stringContaining('pdf:agreement:p-1:doc-1'),
        30 * 24 * 60 * 60,
        expect.any(String),
      );
    });
  });
});
