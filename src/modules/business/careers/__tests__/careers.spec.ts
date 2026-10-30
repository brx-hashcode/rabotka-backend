import { NotFoundException } from '@nestjs/common';
import { OfferQuestionKind } from '@prisma/client';
import { slugBase, uniqueBusinessSlug } from '../careers-slug';
import { CareersService } from '../careers.service';

const business = {
  profile_id: 'p1',
  id: 'b1',
  email: 'rh@kamoa.cg',
  public_slug: 'kamoa',
  name: 'KAMOA',
  category: 'STARTUP',
  city: 'Brazzaville',
  website: null,
  description: 'Fintech',
  profile: { avatar_url: 'https://cdn/logo.png' },
};

const offer = {
  reference: 'RBT-AC5LF',
  title: 'Senior Full Stack Engineer',
  employment_type: 'MISSION',
  scheduled_at: null,
  is_remote: false,
  city: 'Brazzaville',
  country_name: 'Congo',
  quantity: 1,
  description: 'Le poste',
  amount: null,
  payment_flow: null,
  category: { name: 'Informatique' },
  questions: [
    {
      id: 'q1',
      kind: OfferQuestionKind.YES_NO,
      label: 'Avez-vous 5 ans ?',
      options: [],
      required: true,
      knockout: true,
      accepted: ['yes'],
      position: 0,
    },
  ],
};

const storage = {
  upload: jest.fn().mockResolvedValue({ key: 'cv-key' }),
  delete: jest.fn().mockResolvedValue(undefined),
};
const sendMail = jest.fn().mockResolvedValue(undefined);
const emit = jest.fn();

const serviceWith = (found: unknown, offers: unknown[] = [], one?: unknown) => {
  const prisma = {
    business: { findFirst: jest.fn().mockResolvedValue(found) },
    jobOffer: {
      findMany: jest.fn().mockResolvedValue(offers),
      findFirst: jest.fn().mockResolvedValue(one ?? null),
    },
    externalApplication: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'a1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const service = new CareersService(
    prisma as never,
    storage as never,
    { get: jest.fn().mockResolvedValue('kyc-bucket') } as never,
    { get: jest.fn() } as never,
    { sendMail } as never,
    { wrap: jest.fn().mockResolvedValue('<html>') } as never,
    { emit } as never,
  );
  return { prisma, service };
};

describe('careers slug', () => {
  it('keeps letters and digits, without accents', () => {
    expect(slugBase('  Café du Port & Fils ')).toBe('cafe-du-port-fils');
  });

  it('falls back on a name with nothing to keep', () => {
    expect(slugBase('!!!')).toBe('entreprise');
  });

  it('numbers a slug already taken', async () => {
    const tx = {
      business: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { public_slug: 'kamoa' },
            { public_slug: 'kamoa-2' },
          ]),
      },
    };
    await expect(uniqueBusinessSlug(tx as never, 'Kamoa')).resolves.toBe(
      'kamoa-3',
    );
  });
});

describe('CareersService', () => {
  it('only serves a verified, live business', async () => {
    const { prisma, service } = serviceWith(null);

    await expect(service.company('kamoa')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.business.findFirst.mock.calls[0][0].where).toMatchObject({
      public_slug: 'kamoa',
      deleted_at: null,
      verification_status: 'VERIFIED',
    });
  });

  it('lists only open offers past no closing date', async () => {
    const { prisma, service } = serviceWith(business, [offer]);

    const page = await service.company('kamoa');

    expect(page.offers).toHaveLength(1);
    expect(prisma.jobOffer.findMany.mock.calls[0][0].where).toMatchObject({
      employer_id: 'p1',
      status: { in: ['ACTIVE', 'PARTIALLY_FILLED'] },
      deleted_at: null,
    });
  });

  it('answers 404 for a closed offer', async () => {
    const { service } = serviceWith(business);

    await expect(service.offer('kamoa', 'RBT-X')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('never shows which answers a question accepts', async () => {
    const { service } = serviceWith(business, [], offer);

    const { offer: shown } = await service.offer('kamoa', 'RBT-AC5LF');

    expect(shown.questions[0]).toEqual({
      id: 'q1',
      kind: OfferQuestionKind.YES_NO,
      label: 'Avez-vous 5 ans ?',
      options: [],
      required: true,
    });
    expect(JSON.stringify(shown)).not.toContain('accepted');
    expect(JSON.stringify(shown)).not.toContain('knockout');
  });

  it('never puts the name a candidate gave their file in a header', async () => {
    const { prisma, service } = serviceWith(business);
    prisma.externalApplication.findFirst.mockResolvedValue({
      id: 'abcdef12-0000',
      cv_storage_key: 'key',
      cv_storage_bucket: 'bucket',
      cv_mime_type: 'application/pdf',
      cv_file_name: 'mon "cv" — 2026.pdf',
      viewed_at: new Date(),
    });
    (storage as { download?: jest.Mock }).download = jest
      .fn()
      .mockResolvedValue({ body: 'bytes' });

    const file = await service.cvFile('p1', 'abcdef12-0000');

    expect(file.filename).toBe('cv-abcdef12.pdf');
  });

  describe('apply', () => {
    const pdf = {
      buffer: Buffer.from('%PDF-1.7 a real enough start'),
      mimetype: 'application/pdf',
      originalname: 'cv.pdf',
      size: 26,
    } as Express.Multer.File;
    const dto = {
      firstName: ' Awa ',
      lastName: 'Ngoma',
      email: 'Awa@Example.com',
      phone: '+242061234567',
      consent: 'true',
    };
    const open = { ...offer, id: 'o1' };
    const answers = JSON.stringify([{ questionId: 'q1', value: 'no' }]);

    beforeEach(() => jest.clearAllMocks());

    it('keeps a wrong « éliminatoire » answer, flagged', async () => {
      const { prisma, service } = serviceWith(business, [], open);

      await service.apply('kamoa', 'RBT-AC5LF', pdf, { ...dto, answers });

      expect(prisma.externalApplication.create.mock.calls[0][0].data).toMatchObject(
        {
          first_name: 'Awa',
          email: 'awa@example.com',
          knocked_out: true,
          cv_storage_key: 'cv-key',
        },
      );
    });

    it('tells the business and the candidate', async () => {
      const { service } = serviceWith(business, [], open);

      await service.apply('kamoa', 'RBT-AC5LF', pdf, { ...dto, answers });
      await new Promise((resolve) => setImmediate(resolve));

      expect(emit).toHaveBeenCalled();
      expect(sendMail.mock.calls.map(([mail]) => mail.to)).toEqual([
        'awa@example.com',
        'rh@kamoa.cg',
      ]);
    });

    it('refuses a second application with the same email', async () => {
      const { prisma, service } = serviceWith(business, [], open);
      prisma.externalApplication.findUnique.mockResolvedValue({ id: 'a0' });

      await expect(
        service.apply('kamoa', 'RBT-AC5LF', pdf, { ...dto, answers }),
      ).rejects.toThrow('déjà postulé');
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('refuses a file that is not a PDF or Word document', async () => {
      const { service } = serviceWith(business, [], open);

      await expect(
        service.apply(
          'kamoa',
          'RBT-AC5LF',
          { ...pdf, buffer: Buffer.from('not a cv at all') },
          { ...dto, answers },
        ),
      ).rejects.toThrow('PDF');
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('needs the CV', async () => {
      const { service } = serviceWith(business, [], open);

      await expect(
        service.apply('kamoa', 'RBT-AC5LF', undefined, dto),
      ).rejects.toThrow('CV');
    });

    it('drops what a bot sends, and says it worked', async () => {
      const { prisma, service } = serviceWith(business, [], open);

      await expect(
        service.apply('kamoa', 'RBT-AC5LF', pdf, { ...dto, website: 'x' }),
      ).resolves.toEqual({ sent: true });
      expect(prisma.externalApplication.create).not.toHaveBeenCalled();
    });

    it('answers 404 for a closed offer', async () => {
      const { service } = serviceWith(business);

      await expect(
        service.apply('kamoa', 'RBT-X', pdf, dto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
