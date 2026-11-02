import { InboxService } from '../inbox.service';

jest.mock('../../../../common/services/storage/kyc-bucket', () => ({
  kycBucket: jest.fn().mockResolvedValue('kyc-bucket'),
}));

const PDF = Buffer.from('%PDF-1.7 a real enough start');
const file = (over: Partial<Express.Multer.File> = {}) =>
  ({
    originalname: 'CV Awa.pdf',
    mimetype: 'application/pdf',
    size: PDF.length,
    buffer: PDF,
    ...over,
  }) as Express.Multer.File;

function make(opts: { secret?: string; today?: number } = {}) {
  const prisma = {
    business: {
      findUnique: jest.fn().mockResolvedValue({ id: 'b1', deleted_at: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    businessInboxMail: {
      count: jest.fn().mockResolvedValue(opts.today ?? 0),
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const storage = {
    upload: jest.fn().mockResolvedValue({ key: 'k1' }),
    delete: jest.fn().mockResolvedValue(undefined),
    download: jest.fn(),
  };
  const config = {
    get: (k: string) =>
      k === 'INBOUND_MAIL_SECRET'
        ? 'secret' in opts
          ? opts.secret
          : 's3cret'
        : undefined,
  };
  return {
    prisma,
    storage,
    service: new InboxService(
      prisma as never,
      storage as never,
      {} as never,
      config as never,
    ),
  };
}

const mail = {
  to: 'kamoa-a1b2c@cv.rabotka.work',
  from: 'Awa Ngoma <awa@x.cg>',
  subject: 'Candidature comptable',
};

describe('InboxService.receive', () => {
  it('keeps the CV of a mail sent to a known address', async () => {
    const { service, prisma, storage } = make();

    await expect(service.receive('s3cret', mail, [file()])).resolves.toEqual({
      stored: 1,
    });

    expect(prisma.business.findUnique.mock.calls[0][0].where).toEqual({
      inbox_token: 'kamoa-a1b2c',
    });
    expect(storage.upload.mock.calls[0][2]).toMatchObject({
      access: 'private',
      bucket: 'kyc-bucket',
    });
    expect(prisma.businessInboxMail.create.mock.calls[0][0].data).toMatchObject(
      {
        business_id: 'b1',
        from_name: 'Awa Ngoma',
        subject: 'Candidature comptable',
      },
    );
  });

  it('refuses a wrong secret, and works only once one is set', async () => {
    await expect(
      make().service.receive('nope', mail, [file()]),
    ).rejects.toThrow('Unauthorized');
    await expect(
      make({ secret: undefined }).service.receive('s3cret', mail, [file()]),
    ).rejects.toThrow('not configured');
  });

  it('refuses an address on another domain or of nobody', async () => {
    const { service, prisma } = make();
    await expect(
      service.receive('s3cret', { ...mail, to: 'kamoa-a1b2c@evil.cg' }, [
        file(),
      ]),
    ).rejects.toThrow('Unknown address');
    prisma.business.findUnique.mockResolvedValue(null);
    await expect(service.receive('s3cret', mail, [file()])).rejects.toThrow(
      'Unknown address',
    );
  });

  it('keeps only real CV files, and drops a mail with none', async () => {
    const { service, prisma } = make();
    const fake = file({
      originalname: 'cv.pdf',
      buffer: Buffer.from('MZ not a pdf'),
    });
    const logo = file({ originalname: 'logo.gif' });

    await expect(
      service.receive('s3cret', mail, [fake, logo]),
    ).resolves.toEqual({
      stored: 0,
    });
    expect(prisma.businessInboxMail.create).not.toHaveBeenCalled();
  });

  it('stops a flood on one address', async () => {
    await expect(
      make({ today: 300 }).service.receive('s3cret', mail, [file()]),
    ).rejects.toThrow('Too many');
  });
});

describe('InboxService.address', () => {
  it('makes a readable address from the name, once', async () => {
    const { service, prisma } = make();
    prisma.business.findUnique.mockResolvedValue({
      name: 'KAMOA SA',
      inbox_token: null,
    });

    const address = await service.address('b1');

    expect(address).toMatch(/^kamoa-sa-[0-9a-f]{5}@cv\.rabotka\.work$/);
    prisma.business.findUnique.mockResolvedValue({
      name: 'KAMOA SA',
      inbox_token: 'kamoa-sa-12345',
    });
    await expect(service.address('b1')).resolves.toBe(
      'kamoa-sa-12345@cv.rabotka.work',
    );
  });
});

describe('InboxService.list', () => {
  it('lists forwarded mails like a mailbox, with a next page', async () => {
    const { service, prisma } = make();
    prisma.businessInboxMail.findMany.mockResolvedValue(
      Array.from({ length: 21 }, (_, i) => ({
        id: `m${i}`,
        from_name: 'Awa',
        subject: 'CV',
        created_at: new Date('2026-11-02T10:00:00Z'),
        files: [
          {
            id: '0',
            name: 'cv.pdf',
            mime: 'application/pdf',
            size: 10,
            key: 'k',
            bucket: 'b',
          },
        ],
      })),
    );

    const page = await service.list('b1', {});

    expect(page.mails).toHaveLength(20);
    expect(page.next).toBe('20');
    expect(page.mails[0].attachments[0]).toEqual({
      id: '0',
      name: 'cv.pdf',
      size: 10,
      mime: 'application/pdf',
    });
    expect(page.mails[0].attachments[0]).not.toHaveProperty('key');
  });
});
