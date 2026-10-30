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
const screenings = { create: jest.fn() };
const subscriptions = {
  businessOf: jest.fn().mockResolvedValue('b1'),
  entitlements: jest.fn().mockResolvedValue({ cvBatchMax: 2, cvFileMaxMb: 5 }),
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
    screenings as never,
    subscriptions as never,
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
  it('lists hiring businesses, the busiest first', async () => {
    const { prisma, service } = serviceWith(null);
    (prisma.jobOffer as { groupBy?: jest.Mock }).groupBy = jest
      .fn()
      .mockResolvedValue([
        { employer_id: 'p1', _count: { _all: 1 } },
        { employer_id: 'p2', _count: { _all: 3 } },
      ]);
    (prisma.business as { findMany?: jest.Mock }).findMany = jest
      .fn()
      .mockResolvedValue([
        business,
        { ...business, profile_id: 'p2', public_slug: 'sna', name: 'SNA' },
      ]);

    const list = await service.companies();

    expect(list.map((c) => [c.slug, c.openOffers])).toEqual([
      ['sna', 3],
      ['kamoa', 1],
    ]);
    expect(
      (prisma.business as unknown as { findMany: jest.Mock }).findMany.mock
        .calls[0][0].where,
    ).toMatchObject({ verification_status: 'VERIFIED', deleted_at: null });
    expect(JSON.stringify(list)).not.toContain('rh@kamoa.cg');
  });

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

  describe('analyse', () => {
    const due = (id: string) => ({
      id,
      first_name: 'Awa',
      last_name: 'Ngoma',
      cv_mime_type: 'application/pdf',
      cv_size_bytes: 3,
      cv_storage_key: 'key',
      cv_storage_bucket: 'bucket',
    });
    const withDue = (open: { id: string } | null, ids = ['a1', 'a2']) => {
      const made = serviceWith(business);
      const prisma = made.prisma as unknown as {
        externalApplication: Record<string, jest.Mock>;
        cvScreening: Record<string, jest.Mock>;
        cvScreeningResume: Record<string, jest.Mock>;
      };
      prisma.externalApplication.findMany = jest
        .fn()
        .mockResolvedValue(ids.map(due));
      prisma.externalApplication.count = jest.fn().mockResolvedValue(3);
      prisma.cvScreening = {
        findFirst: jest.fn().mockResolvedValue(open),
        update: jest.fn().mockResolvedValue({}),
      };
      prisma.cvScreeningResume = { update: jest.fn().mockResolvedValue({}) };
      (storage as { download?: jest.Mock }).download = jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({
            body: (async function* () {
              yield Buffer.from('cv!');
            })(),
          }),
        );
      screenings.create.mockResolvedValue({
        id: 's1',
        resumes: ids.map((id) => ({
          id: `r-${id}`,
          fileName: `Awa Ngoma ${id}.pdf`,
        })),
      });
      return { service: made.service, prisma };
    };

    beforeEach(() => jest.clearAllMocks());

    it('opens the offer’s screening and links each CV to its resume', async () => {
      const { service, prisma } = withDue(null);

      const result = await service.analyse('p1', 'o1');

      expect(result).toEqual({ screeningId: 's1', analysed: 2, left: 1 });
      expect(screenings.create.mock.calls[0][3]).toBeUndefined();
      expect(prisma.cvScreening.update.mock.calls[0][0].data).toEqual({
        external: true,
      });
      expect(
        prisma.externalApplication.update.mock.calls.map(
          ([call]) => call.data.cv_resume_id,
        ),
      ).toEqual(['r-a1', 'r-a2']);
      expect(prisma.cvScreeningResume.update.mock.calls[0][0].data).toEqual({
        file_name: 'Awa Ngoma.pdf',
      });
    });

    it('joins the screening already open, so they can be compared', async () => {
      const { service, prisma } = withDue({ id: 's0' });

      await service.analyse('p1', 'o1');

      expect(screenings.create.mock.calls[0][3]).toBe('s0');
      expect(prisma.cvScreening.update).not.toHaveBeenCalled();
    });

    it('only takes what the plan allows at once, not yet read and waiting', async () => {
      const { service, prisma } = withDue(null);

      await service.analyse('p1', 'o1');

      const query = prisma.externalApplication.findMany.mock.calls[0][0];
      expect(query.take).toBe(2);
      expect(query.where).toMatchObject({
        job_offer_id: 'o1',
        job_offer: { employer_id: 'p1' },
        status: 'PENDING',
        cv_resume_id: null,
      });
    });

    it('says so when there is nothing to read', async () => {
      const { service } = withDue(null, []);

      await expect(service.analyse('p1', 'o1')).rejects.toThrow('Aucun CV');
      expect(screenings.create).not.toHaveBeenCalled();
    });
  });

  describe('decisions', () => {
    const application = {
      id: 'a1',
      status: 'PENDING',
      email: 'awa@example.com',
      first_name: 'Awa',
      job_offer: { title: 'Dev' },
    };
    const owned = (status: string) => {
      const made = serviceWith(business);
      made.prisma.externalApplication.findFirst.mockResolvedValue({
        ...application,
        status,
      });
      (made.prisma.business as { findUnique?: jest.Mock }).findUnique = jest
        .fn()
        .mockResolvedValue({ name: 'KAMOA' });
      return made;
    };

    beforeEach(() => jest.clearAllMocks());

    it('retains a candidate and tells them', async () => {
      const { prisma, service } = owned('PENDING');

      await service.retain('p1', 'a1');
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        prisma.externalApplication.update.mock.calls[0][0].data.status,
      ).toBe('RETAINED');
      expect(sendMail.mock.calls[0][0].to).toBe('awa@example.com');
    });

    it('does not retain someone already refused', async () => {
      const { service } = owned('REFUSED');

      await expect(service.retain('p1', 'a1')).rejects.toThrow('refusée');
    });

    it('does not refuse someone already retained', async () => {
      const { prisma, service } = owned('RETAINED');

      await service.refuse('p1', 'a1');

      expect(prisma.externalApplication.update).not.toHaveBeenCalled();
    });

    it('refuses those still waiting when the offer closes', async () => {
      const { prisma, service } = owned('PENDING');
      (
        prisma.externalApplication as unknown as { findMany: jest.Mock }
      ).findMany = jest.fn().mockResolvedValue([{ id: 'a1' }]);

      await service.refuseWaiting({ jobOfferId: 'o1', employerId: 'p1' });

      expect(
        prisma.externalApplication.update.mock.calls[0][0].data.status,
      ).toBe('REFUSED');
    });
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

      expect(
        prisma.externalApplication.create.mock.calls[0][0].data,
      ).toMatchObject({
        first_name: 'Awa',
        email: 'awa@example.com',
        knocked_out: true,
        cv_storage_key: 'cv-key',
      });
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
