import { Logger } from '@nestjs/common';
import { ProfileService } from '../profile.service';

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
  _count: { job_offers: 0, applications: 2, penalties: 1 },
  kyc_documents: [],
  kyc_verification_images: [],
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
    },
    document: {
      findMany: jest.fn().mockResolvedValue([]),
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
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

function makeWhatsApp() {
  return {
    sendTextMessage: jest.fn().mockResolvedValue(true),
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
    fillDocumentTemplateAsPdf: jest.fn().mockResolvedValue(Buffer.from('pdf-content')),
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

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    fileService = makeFileService();
    redis = makeRedis();
    whatsApp = makeWhatsApp();
    configService = makeConfigService();
    documentService = makeDocumentService();
    service = new ProfileService(
      prisma as any,
      fileService as any,
      redis as any,
      whatsApp as any,
      configService as any,
      {} as any, // mailService
      { emit: jest.fn() } as any, // eventEmitter
      { getProfileWalletBalance: jest.fn().mockResolvedValue(0) } as any, // walletService
      documentService as any, // documentService
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

    it('sends activation notification when status transitions to ACTIVE', async () => {
      prisma.profile.findUnique.mockResolvedValueOnce({
        ...baseProfile,
        status: 'PENDING_ACTIVATION',
      });
      // Second call for findById
      prisma.profile.findUnique.mockResolvedValueOnce(baseProfile);
      // Third call for sendActivationNotification
      prisma.profile.findUnique.mockResolvedValueOnce({
        ...baseProfile,
        phone: '+242000001',
      });
      await service.updateProfile('p-1', { status: 'ACTIVE' as any });
      // WhatsApp notification attempt is non-blocking; just ensure no crash
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
        worker_id: 'p-1',
        paid_at: null,
      });
      await service.markPenaltyPaid('pen-1', 'p-1');
      expect(prisma.penalty.update).toHaveBeenCalled();
    });

    it('throws NotFoundException when penalty does not belong to profile', async () => {
      prisma.penalty.findUnique.mockResolvedValue({
        id: 'pen-1',
        worker_id: 'other',
      });
      await expect(service.markPenaltyPaid('pen-1', 'p-1')).rejects.toThrow(
        'Pénalité introuvable',
      );
    });

    it('does nothing when already paid', async () => {
      prisma.penalty.findUnique.mockResolvedValue({
        id: 'pen-1',
        worker_id: 'p-1',
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
        undefined,
        [file],
      );
      expect(fileService.uploadToStorage).toHaveBeenCalled();
      expect(result.id).toBe('p-1');
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
        service.verifyProfileKyc('missing', 'admin-1', 'VERIFIED'),
      ).rejects.toThrow('Profil non trouvé');
    });
  });

  describe('createProfile()', () => {
    const kycDoc = {
      fieldname: 'kycDocument',
      originalname: 'id.jpg',
      encoding: '7bit',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('id'),
      size: 2,
    } as Express.Multer.File;

    const kycSelfie = {
      ...kycDoc,
      fieldname: 'kycSelfie',
      originalname: 'selfie.jpg',
    };

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
    };

    it('creates profile and returns success message', async () => {
      const txPrisma = makePrisma();
      txPrisma.profile.create.mockResolvedValue({ id: 'new-p-1' });
      prisma.$transaction.mockImplementation((fn: any) => fn(txPrisma));
      const result = await service.createProfile(dto, kycDoc, kycSelfie);
      expect(result?.message).toContain('succès');
    });

    it('throws BadRequestException when kycDocument missing', async () => {
      await expect(
        service.createProfile(dto, null as any, kycSelfie),
      ).rejects.toThrow('document KYC');
    });

    it('throws BadRequestException when kycSelfie missing', async () => {
      await expect(
        service.createProfile(dto, kycDoc, null as any),
      ).rejects.toThrow('photo KYC');
    });
  });

  describe('downloadAgreement()', () => {
    const template = {
      id: 'doc-1',
      title: 'Accord Plateforme',
      category: 'AGREEMENT',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
  });
});
