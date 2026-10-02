import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  AgentStatus,
  DocumentType,
  KycDocumentCategory,
  Prisma,
} from '@prisma/client';
import { AdminAgentService } from '../admin-agent.service';
import type { CreateAgentDto } from '../dto/admin-agent.dto';

jest.mock('../../../common/services/storage/kyc-bucket', () => ({
  kycBucket: jest.fn().mockResolvedValue('kyc-bucket'),
}));

const ADMIN_ID = '00000000-0000-0000-0000-00000000a0a0';

const DETAIL_ROW = {
  id: 'agent-1',
  created_at: new Date(),
  updated_at: new Date(),
  first_name: 'Awa',
  last_name: 'Ngoma',
  email: 'awa@example.com',
  phone: '+242060000000',
  avatar_url: null,
  status: AgentStatus.ACTIVE,
  last_login_at: null,
  zones: [{ country_code: 'CG', city: 'Brazzaville' }],
  id_document_type: DocumentType.IDENTITY_CARD,
  id_document_number: 'AB123',
  status_reason: null,
  created_by_user_id: ADMIN_ID,
  kyc_documents: [],
};

function validDto(overrides: Partial<CreateAgentDto> = {}): CreateAgentDto {
  return {
    firstName: 'Awa',
    lastName: 'Ngoma',
    email: ' AWA@example.com ',
    phone: '+242 06 000 00 00',
    idDocumentType: DocumentType.IDENTITY_CARD,
    idDocumentNumber: 'ab 123',
    zones: [{ countryCode: 'CG', city: 'brazzaville' }],
    kycDocuments: [
      {
        category: KycDocumentCategory.DOCUMENT,
        key: 'kyc-documents/agents/f.jpg',
      },
      {
        category: KycDocumentCategory.DOCUMENT_BACK,
        key: 'kyc-documents/agents/b.jpg',
      },
      {
        category: KycDocumentCategory.SELFIE,
        key: 'kyc-documents/agents/s.jpg',
      },
    ],
    ...overrides,
  };
}

function p2002(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint', {
    code: 'P2002',
    clientVersion: '7.9.1',
    meta,
  });
}

describe('AdminAgentService', () => {
  let prisma: any;
  let files: {
    uploadToStorage: jest.Mock;
    exists: jest.Mock;
    download: jest.Mock;
  };
  let storage: { getUrl: jest.Mock; delete: jest.Mock };
  let geo: { resolveLocation: jest.Mock };
  let mail: { sendMail: jest.Mock };
  let service: AdminAgentService;

  beforeEach(() => {
    prisma = {
      agent: {
        create: jest.fn().mockResolvedValue(DETAIL_ROW),
        findUnique: jest.fn().mockResolvedValue(DETAIL_ROW),
        update: jest.fn().mockResolvedValue(DETAIL_ROW),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: 'Ada', last_name: 'Admin' }),
      },
      agentKycDocument: {
        upsert: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn(),
      },
    };
    files = {
      uploadToStorage: jest
        .fn()
        .mockResolvedValue({ key: 'k', url: 'https://cdn/k' }),
      exists: jest.fn().mockResolvedValue(true),
      download: jest.fn(),
    };
    storage = {
      getUrl: jest.fn().mockResolvedValue('https://cdn/avatars/agents/a.jpg'),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    geo = {
      resolveLocation: jest.fn(({ countryCode, city }) => ({
        country_code: countryCode,
        country_name: 'Congo',
        city: city.charAt(0).toUpperCase() + city.slice(1),
      })),
    };
    mail = { sendMail: jest.fn().mockResolvedValue({ jobId: '1' }) };
    const layout = { wrap: jest.fn().mockResolvedValue('<html/>') };

    service = new AdminAgentService(
      prisma,
      files as any,
      storage as any,
      {} as any,
      {} as any,
      geo as any,
      mail as any,
      layout as any,
    );
  });

  describe('uploads', () => {
    it('writes identity documents to the PRIVATE bucket and returns only the key', async () => {
      const result = await service.uploadKycFile({} as Express.Multer.File);
      expect(files.uploadToStorage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          folder: 'kyc-documents/agents',
          access: 'private',
          bucket: 'kyc-bucket',
        }),
      );
      expect(result).toEqual({ key: 'k' });
    });

    it('writes avatars to the public agents folder', async () => {
      await service.uploadAvatar({} as Express.Multer.File);
      expect(files.uploadToStorage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ folder: 'avatars/agents', access: 'public' }),
      );
    });
  });

  describe('create', () => {
    it('normalises every identity field and records the creating admin', async () => {
      await service.create(validDto(), ADMIN_ID);

      const data = prisma.agent.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        email: 'awa@example.com',
        phone: '+242060000000',
        id_document_number: 'AB123',
        created_by_user_id: ADMIN_ID,
        zones: { create: [{ country_code: 'CG', city: 'Brazzaville' }] },
      });
      expect(data.kyc_documents.create).toHaveLength(3);
      expect(data.kyc_documents.create[0].uploaded_by_user_id).toBe(ADMIN_ID);
    });

    it('sends the welcome email', async () => {
      await service.create(validDto(), ADMIN_ID);
      await new Promise(setImmediate);
      expect(mail.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'awa@example.com' }),
      );
    });

    it('refuses an incomplete identity file', async () => {
      const dto = validDto({
        kycDocuments: validDto().kycDocuments.slice(0, 2),
      });
      await expect(service.create(dto, ADMIN_ID)).rejects.toThrow(/SELFIE/);
      expect(prisma.agent.create).not.toHaveBeenCalled();
    });

    it('refuses a back side for a passport', async () => {
      const dto = validDto({ idDocumentType: DocumentType.PASSPORT });
      await expect(service.create(dto, ADMIN_ID)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('accepts a passport with front and selfie only', async () => {
      const dto = validDto({
        idDocumentType: DocumentType.PASSPORT,
        kycDocuments: validDto().kycDocuments.filter(
          (d) => d.category !== KycDocumentCategory.DOCUMENT_BACK,
        ),
      });
      await expect(service.create(dto, ADMIN_ID)).resolves.toBeDefined();
    });

    it('refuses a key outside the agents KYC folder — e.g. a profile document', async () => {
      const docs = validDto().kycDocuments;
      docs[0] = { ...docs[0], key: 'kyc-documents/someone-elses-passport.jpg' };
      await expect(
        service.create(validDto({ kycDocuments: docs }), ADMIN_ID),
      ).rejects.toThrow('Référence de fichier invalide');
      expect(files.exists).not.toHaveBeenCalled();
    });

    it('refuses a key whose file is not in the private bucket', async () => {
      files.exists.mockResolvedValueOnce(false);
      await expect(service.create(validDto(), ADMIN_ID)).rejects.toThrow(
        /téléversez/,
      );
      expect(files.exists).toHaveBeenCalledWith(
        expect.any(String),
        'kyc-bucket',
      );
    });

    it('refuses a phone without a country code', async () => {
      await expect(
        service.create(validDto({ phone: '06 12' }), ADMIN_ID),
      ).rejects.toThrow(/indicatif/);
    });

    it('derives the avatar url from the key, never from the client', async () => {
      await service.create(
        validDto({ avatarKey: 'avatars/agents/a.jpg' }),
        ADMIN_ID,
      );
      expect(storage.getUrl).toHaveBeenCalledWith('avatars/agents/a.jpg', {
        access: 'public',
      });
      expect(prisma.agent.create.mock.calls[0][0].data.avatar_url).toBe(
        'https://cdn/avatars/agents/a.jpg',
      );
    });

    it('refuses an avatar key from another folder', async () => {
      await expect(
        service.create(validDto({ avatarKey: 'avatars/x.jpg' }), ADMIN_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it.each([
      [{ target: ['email'] }, /email/],
      [{ target: ['phone'] }, /numéro/],
      [{ target: ['id_document_type', 'id_document_number'] }, /pièce/],
      // Driver-adapter shape: no `target`, fields nested deeper.
      [
        {
          driverAdapterError: {
            cause: { constraint: { fields: ['email'] } },
          },
        },
        /email/,
      ],
    ])('names the duplicate field (%j)', async (meta, message) => {
      prisma.agent.create.mockRejectedValue(p2002(meta));
      const err = await service.create(validDto(), ADMIN_ID).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toMatch(message);
    });
  });

  describe('setStatus', () => {
    it('requires a reason to suspend', async () => {
      await expect(service.setStatus('agent-1', 'suspend')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.agent.updateMany).not.toHaveBeenCalled();
    });

    it('suspends only from ACTIVE, atomically', async () => {
      await service.setStatus('agent-1', 'suspend', ' fraude ');
      expect(prisma.agent.updateMany).toHaveBeenCalledWith({
        where: { id: 'agent-1', status: { in: [AgentStatus.ACTIVE] } },
        data: { status: AgentStatus.SUSPENDED, status_reason: 'fraude' },
      });
    });

    it('clears the reason on reactivation', async () => {
      await service.setStatus('agent-1', 'reactivate');
      expect(prisma.agent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: AgentStatus.ACTIVE, status_reason: null },
        }),
      );
    });

    it('never brings back a revoked agent', async () => {
      prisma.agent.updateMany.mockResolvedValue({ count: 0 });
      prisma.agent.findUnique.mockResolvedValue({
        status: AgentStatus.REVOKED,
      });
      await expect(service.setStatus('agent-1', 'reactivate')).rejects.toThrow(
        ConflictException,
      );
    });

    it('404s an unknown agent', async () => {
      prisma.agent.updateMany.mockResolvedValue({ count: 0 });
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(
        service.setStatus('nope', 'revoke', 'fin de contrat'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('replaceKycDocument', () => {
    it('refuses a category the document type does not have', async () => {
      prisma.agent.findUnique.mockResolvedValueOnce({
        id_document_type: DocumentType.PASSPORT,
      });
      await expect(
        service.replaceKycDocument(
          'agent-1',
          KycDocumentCategory.DOCUMENT_BACK,
          'kyc-documents/agents/b.jpg',
          ADMIN_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('records who replaced it', async () => {
      prisma.agent.findUnique.mockResolvedValueOnce({
        id_document_type: DocumentType.IDENTITY_CARD,
      });
      await service.replaceKycDocument(
        'agent-1',
        KycDocumentCategory.SELFIE,
        'kyc-documents/agents/s2.jpg',
        ADMIN_ID,
      );
      expect(prisma.agentKycDocument.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            storage_key: 'kyc-documents/agents/s2.jpg',
            uploaded_by_user_id: ADMIN_ID,
          },
        }),
      );
    });
  });

  it('deletes the old avatar only after the new one is saved', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      avatar_storage_key: 'avatars/agents/old.jpg',
    });
    await service.replaceAvatar('agent-1', 'avatars/agents/new.jpg');

    const updateOrder = prisma.agent.update.mock.invocationCallOrder[0];
    const deleteOrder = storage.delete.mock.invocationCallOrder[0];
    expect(storage.delete).toHaveBeenCalledWith('avatars/agents/old.jpg');
    expect(updateOrder).toBeLessThan(deleteOrder);
  });

  it('tells the admin image from PDF, without ever returning the storage key', async () => {
    prisma.agent.findUnique.mockResolvedValueOnce({
      ...DETAIL_ROW,
      kyc_documents: [
        {
          id: 'd1',
          document_category: KycDocumentCategory.DOCUMENT,
          storage_key: 'kyc-documents/agents/front.jpg',
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'd2',
          document_category: KycDocumentCategory.SELFIE,
          storage_key: 'kyc-documents/agents/selfie.pdf',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const detail = await service.getDetail('agent-1');

    expect(detail.kycDocuments.map((d) => d.contentKind)).toEqual([
      'image',
      'pdf',
    ]);
    expect(JSON.stringify(detail)).not.toContain('kyc-documents/agents');
  });

  it('streams a document only for the agent it belongs to', async () => {
    prisma.agentKycDocument.findFirst.mockResolvedValue(null);
    await expect(
      service.streamKycDocument('agent-1', 'doc-of-someone-else'),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.agentKycDocument.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'doc-of-someone-else', agent_id: 'agent-1' },
      }),
    );
    expect(files.download).not.toHaveBeenCalled();
  });
});

describe('AdminAgentService – creator name', () => {
  it('names the admin who created the agent', async () => {
    const prisma: any = {
      agent: { findUnique: jest.fn().mockResolvedValue(DETAIL_ROW) },
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ first_name: 'Ada', last_name: 'Admin' }),
      },
    };
    const service = new AdminAgentService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const detail = await service.getDetail('agent-1');
    expect(detail.createdByName).toBe('Ada Admin');
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ADMIN_ID } }),
    );
  });
});

describe('AdminAgentService – document view log window', () => {
  it('reports a new window only when the admin has no view logged this hour', async () => {
    const findFirst = jest.fn().mockResolvedValueOnce(null);
    const prisma: any = { log: { findFirst } };
    const service = new AdminAgentService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.isNewKycViewWindow('agent-1', 'admin-1'),
    ).resolves.toBe(true);
    findFirst.mockResolvedValueOnce({ id: 'log-1' });
    await expect(
      service.isNewKycViewWindow('agent-1', 'admin-1'),
    ).resolves.toBe(false);

    const where = findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      action: 'AGENT_KYC_VIEWED',
      entity_id: 'agent-1',
      user_id: 'admin-1',
    });
    expect(Date.now() - where.created_at.gte.getTime()).toBeGreaterThanOrEqual(
      59 * 60 * 1000,
    );
  });
});

describe('AdminAgentService – zone filter', () => {
  function make(prisma: any) {
    return new AdminAgentService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  }

  it('matches agents covering ANY of the zones, each by country and city', async () => {
    const prisma: any = {
      agent: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    await make(prisma).list({
      page: 1,
      limit: 20,
      q: 'awa',
      zone: ['CG:Brazzaville', 'CD:Brazzaville'],
    });

    const where = prisma.agent.findMany.mock.calls[0][0].where;
    // Kept apart from the search OR, so neither overwrites the other.
    expect(where.OR).toHaveLength(4);
    expect(where.AND).toEqual([
      {
        zones: {
          some: {
            OR: [
              { country_code: 'CG', city: 'Brazzaville' },
              { country_code: 'CD', city: 'Brazzaville' },
            ],
          },
        },
      },
    ]);
  });

  it('lists covered cities with agent counts, revoked agents excluded', async () => {
    const groupBy = jest
      .fn()
      .mockResolvedValue([
        { country_code: 'CG', city: 'Brazzaville', _count: { _all: 3 } },
      ]);
    const zones = await make({ agentZone: { groupBy } }).listZones();

    expect(zones).toEqual([
      { countryCode: 'CG', city: 'Brazzaville', agents: 3 },
    ]);
    expect(groupBy.mock.calls[0][0].where).toEqual({
      agent: { status: { not: 'REVOKED' } },
    });
  });
});

describe('AdminAgentService – country filter', () => {
  it('requires both the country and the city conditions when both are set', async () => {
    const prisma: any = {
      agent: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new AdminAgentService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await service.list({
      page: 1,
      limit: 20,
      country: ['CG'],
      zone: ['CG:Brazzaville'],
    });

    const where = prisma.agent.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      { zones: { some: { country_code: { in: ['CG'] } } } },
      {
        zones: {
          some: { OR: [{ country_code: 'CG', city: 'Brazzaville' }] },
        },
      },
    ]);
  });
});
