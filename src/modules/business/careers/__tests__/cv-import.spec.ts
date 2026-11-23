import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ExternalApplicationOrigin, Prisma } from '@prisma/client';
import { CareersService, placeholderName } from '../careers.service';
import { fillImportedContact, splitName } from '../imported-contact';

const pdf = (name: string) => ({
  originalname: name,
  mimetype: 'application/pdf',
  size: 1000,
  buffer: Buffer.from('%PDF-1.7 a real enough start'),
});

const setup = (
  entitlements: Record<string, unknown> = {
    cvBatchMax: 10,
    cvRemaining: 3,
    cvFileMaxMb: 5,
    trialLocked: [],
  },
) => {
  const prisma = {
    jobOffer: { findFirst: jest.fn().mockResolvedValue({ id: 'o1' }) },
    externalApplication: { create: jest.fn().mockResolvedValue({}) },
  };
  const storage = {
    upload: jest.fn().mockResolvedValue({ key: 'cv-key' }),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const sendMail = jest.fn();
  const emit = jest.fn();
  const queueAdd = jest.fn().mockResolvedValue({});
  const service = new CareersService(
    prisma as never,
    storage as never,
    { get: jest.fn().mockResolvedValue('kyc-bucket') } as never,
    { get: jest.fn() } as never,
    { sendMail } as never,
    { wrap: jest.fn() } as never,
    { emit } as never,
    {} as never,
    {
      businessOf: jest.fn().mockResolvedValue('b1'),
      entitlements: jest.fn().mockResolvedValue(entitlements),
    } as never,
    { getQueue: jest.fn(() => ({ add: queueAdd })) } as never,
  );
  return { prisma, storage, sendMail, emit, queueAdd, service };
};

describe('importing CVs into an offer', () => {
  it('makes each CV a candidate of the offer, queued for its analysis, telling nobody', async () => {
    const { prisma, sendMail, emit, queueAdd, service } = setup();
    await expect(
      service.importCvs('p1', 'o1', [
        { ...pdf('CV_Julien-Mbongolo.pdf'), source: 'import-device' },
        { ...pdf('grace.pdf'), source: 'import-gmail' },
      ]),
    ).resolves.toEqual({ imported: 2 });

    expect(prisma.jobOffer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'o1', employer_id: 'p1' }),
      }),
    );
    const rows = prisma.externalApplication.create.mock.calls.map(
      ([arg]: [{ data: Record<string, unknown> }]) => arg.data,
    );
    expect(rows[0]).toMatchObject({
      job_offer_id: 'o1',
      origin: ExternalApplicationOrigin.IMPORT,
      first_name: 'CV Julien Mbongolo',
      last_name: '',
      source: 'import-device',
      cv_mime_type: 'application/pdf',
    });
    expect(rows[0]).not.toHaveProperty('email');
    expect(rows[0]).not.toHaveProperty('consented_at');
    expect(rows[1]).toMatchObject({ source: 'import-gmail' });
    expect(queueAdd).toHaveBeenCalledTimes(2);
    expect(queueAdd.mock.calls[0][1]).toMatchObject({
      kind: 'careers',
      offerId: 'o1',
      employerId: 'p1',
    });
    expect(sendMail).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses a batch above the CVs the plan has left, whole', async () => {
    const { prisma, service } = setup();
    await expect(
      service.importCvs(
        'p1',
        'o1',
        ['a', 'b', 'c', 'd'].map((n) => ({
          ...pdf(`${n}.pdf`),
          source: 'import-device' as const,
        })),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.externalApplication.create).not.toHaveBeenCalled();
  });

  it('refuses when the plan has no CV left', async () => {
    const { service } = setup({
      cvBatchMax: 10,
      cvRemaining: 0,
      cvFileMaxMb: 5,
      trialLocked: [],
    });
    await expect(
      service.importCvs('p1', 'o1', [
        { ...pdf('a.pdf'), source: 'import-device' },
      ]),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses a file that is not a CV', async () => {
    const { prisma, service } = setup();
    await expect(
      service.importCvs('p1', 'o1', [
        {
          originalname: 'notes.txt',
          mimetype: 'text/plain',
          size: 10,
          buffer: Buffer.from('hello'),
          source: 'import-device',
        },
      ]),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.externalApplication.create).not.toHaveBeenCalled();
  });

  it('refuses an offer that is not the business’s, or no longer open', async () => {
    const { prisma, service } = setup();
    prisma.jobOffer.findFirst.mockResolvedValue(null);
    await expect(
      service.importCvs('p1', 'o1', [
        { ...pdf('a.pdf'), source: 'import-device' },
      ]),
    ).rejects.toThrow('Cette offre ne recrute plus.');
  });
});

describe('names until the CV is read', () => {
  it('reads the file name as words', () => {
    expect(placeholderName('CV_Julien-Mbongolo_2026.pdf')).toBe(
      'CV Julien Mbongolo 2026',
    );
    expect(placeholderName('.pdf')).toBe('CV');
  });

  it('splits a full name on its first word', () => {
    expect(splitName(' Julien  MBONGOLO ')).toEqual({
      first: 'Julien',
      last: 'MBONGOLO',
    });
    expect(splitName('Grace')).toEqual({ first: 'Grace', last: '' });
  });
});

describe('the contact an analysis read', () => {
  const prismaWith = (
    application: unknown,
    taken: unknown = null,
  ): {
    externalApplication: { findFirst: jest.Mock; update: jest.Mock };
  } => ({
    externalApplication: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(application)
        .mockResolvedValueOnce(taken),
      update: jest.fn().mockResolvedValue({}),
    },
  });
  const imported = { id: 'a1', job_offer_id: 'o1', email: null, phone: null };

  it('becomes the imported candidate’s', async () => {
    const prisma = prismaWith(imported);
    await fillImportedContact(prisma as never, 'r1', {
      name: 'Julien MBONGOLO',
      email: ' Julien@Mail.CG ',
      phone: '+242 06 000 00 00',
    });
    expect(prisma.externalApplication.findFirst.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        where: { cv_resume_id: 'r1', origin: ExternalApplicationOrigin.IMPORT },
      }),
    );
    expect(prisma.externalApplication.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: {
        first_name: 'Julien',
        last_name: 'MBONGOLO',
        email: 'julien@mail.cg',
        phone: '+242 06 000 00 00',
      },
    });
  });

  it('never takes an address another candidate of the offer has', async () => {
    const prisma = prismaWith(imported, { id: 'a2' });
    await fillImportedContact(prisma as never, 'r1', {
      name: 'Julien MBONGOLO',
      email: 'julien@mail.cg',
      phone: null,
    });
    expect(prisma.externalApplication.update.mock.calls[0][0].data).toEqual({
      first_name: 'Julien',
      last_name: 'MBONGOLO',
    });
  });

  it('keeps the rest when the address is taken meanwhile', async () => {
    const prisma = prismaWith(imported);
    prisma.externalApplication.update
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      )
      .mockResolvedValueOnce({});
    await fillImportedContact(prisma as never, 'r1', {
      name: 'Julien MBONGOLO',
      email: 'julien@mail.cg',
      phone: null,
    });
    expect(prisma.externalApplication.update).toHaveBeenCalledTimes(2);
    expect(prisma.externalApplication.update.mock.calls[1][0].data).toEqual({
      first_name: 'Julien',
      last_name: 'MBONGOLO',
    });
  });

  it('leaves a careers application as its candidate typed it', async () => {
    const prisma = prismaWith(null);
    await fillImportedContact(prisma as never, 'r1', {
      name: 'Someone Else',
      email: 'x@y.cg',
      phone: null,
    });
    expect(prisma.externalApplication.update).not.toHaveBeenCalled();
  });
});

describe('deleting imported CVs', () => {
  const make = (rows: unknown[]) => {
    const prisma = {
      externalApplication: {
        findMany: jest.fn().mockResolvedValue(rows),
        deleteMany: jest.fn().mockReturnValue('delete-applications'),
      },
      cvScreeningResume: {
        deleteMany: jest.fn().mockReturnValue('delete-resumes'),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const service = new CareersService(
      prisma as never,
      storage as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { prisma, storage, service };
  };

  it('only ever looks at the business’s imports that are not retained', async () => {
    const { prisma, service } = make([]);
    await expect(service.deleteImported('p1', ['a1'])).resolves.toEqual({
      deleted: 0,
      kept: 1,
    });
    expect(prisma.externalApplication.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        id: { in: ['a1'] },
        origin: ExternalApplicationOrigin.IMPORT,
        status: { not: 'RETAINED' },
        job_offer: { employer_id: 'p1' },
      }),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('removes the candidate, its analysis and both files', async () => {
    const { prisma, storage, service } = make([
      {
        id: 'a1',
        cv_storage_key: 'ext/a1.pdf',
        cv_storage_bucket: 'kyc',
        cv_resume: {
          id: 'r1',
          storage_key: 'cv/r1.pdf',
          storage_bucket: 'kyc',
        },
      },
      {
        id: 'a2',
        cv_storage_key: 'ext/a2.pdf',
        cv_storage_bucket: 'kyc',
        cv_resume: null,
      },
    ]);
    await expect(
      service.deleteImported('p1', ['a1', 'a2', 'careers-1']),
    ).resolves.toEqual({ deleted: 2, kept: 1 });
    expect(prisma.externalApplication.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2'] } },
    });
    expect(prisma.cvScreeningResume.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] } },
    });
    expect(storage.delete.mock.calls.map((c) => c[0])).toEqual([
      'ext/a1.pdf',
      'ext/a2.pdf',
      'cv/r1.pdf',
    ]);
  });
});
