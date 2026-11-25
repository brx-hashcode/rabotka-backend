import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AnswerFilesService } from '../answer-files.service';

const pdf = {
  originalname: 'diplome.pdf',
  mimetype: 'application/pdf',
  size: 1000,
  buffer: Buffer.from('%PDF-1.7 a real enough start'),
};

const setup = (offer: unknown = { id: 'o1' }) => {
  const prisma = {
    jobOffer: { findFirst: jest.fn().mockResolvedValue(offer) },
    answerFile: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const storage = {
    upload: jest.fn().mockResolvedValue({ key: 'answer-files/o1/x.pdf' }),
    delete: jest.fn().mockResolvedValue(undefined),
    download: jest.fn(),
  };
  const service = new AnswerFilesService(
    prisma as never,
    storage as never,
    { get: jest.fn().mockResolvedValue('kyc-bucket') } as never,
    { get: jest.fn() } as never,
  );
  return { prisma, storage, service };
};

describe('AnswerFilesService', () => {
  it('stores a worker’s file for an offer that asks for one, unused until applied with', async () => {
    const { prisma, storage, service } = setup();
    const stored = await service.upload('o1', pdf, { profileId: 'w1' });
    expect(stored.name).toBe('diplome.pdf');
    expect(stored.value).toBe(`${stored.id}:diplome.pdf`);
    expect(storage.upload.mock.calls[0][2]).toMatchObject({
      folder: `answer-files/o1/${stored.id}`,
      access: 'private',
    });
    expect(prisma.answerFile.create.mock.calls[0][0].data).toMatchObject({
      job_offer_id: 'o1',
      profile_id: 'w1',
      attached_at: null,
    });
  });

  it('refuses an offer that asks for no file', async () => {
    const { service } = setup(null);
    await expect(
      service.upload('o1', pdf, { profileId: 'w1' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses a file that is not a document or a photo', async () => {
    const { service } = setup();
    await expect(
      service.upload(
        'o1',
        { ...pdf, originalname: 'a.txt', buffer: Buffer.from('hello') },
        { profileId: 'w1' },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('only lets a worker apply with their own unused uploads for that offer', async () => {
    const { prisma, service } = setup();
    const id = '3f2b8a1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    await service.claim('o1', 'w1', [`${id}:diplome.pdf`]);
    expect(prisma.answerFile.updateMany.mock.calls[0][0].where).toMatchObject({
      id: { in: [id] },
      job_offer_id: 'o1',
      profile_id: 'w1',
      attached_at: null,
    });
    prisma.answerFile.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.claim('o1', 'w1', [`${id}:diplome.pdf`]),
    ).rejects.toThrow('ajoutez-le à nouveau');
  });

  it('sweeps attached files by their date, and unused uploads after a day', async () => {
    const { service, prisma } = setup();
    const now = new Date('2026-12-02T00:00:00Z');
    await service.sweep(now);
    expect(prisma.answerFile.findMany.mock.calls[0][0].where.OR).toEqual([
      {
        attached_at: null,
        created_at: { lt: new Date('2026-12-01T00:00:00Z') },
      },
      { expires_at: { lte: now } },
    ]);
  });

  it('deletes the files the business removes, due now if the storage fails', async () => {
    const { service, prisma, storage } = setup();
    prisma.answerFile.findMany.mockResolvedValue([
      { id: 'f1', storage_key: 'k', storage_bucket: 'b' },
    ]);
    storage.delete.mockRejectedValueOnce(new Error('S3 down'));
    const now = new Date();
    await service.remove(['f1'], now);
    expect(prisma.answerFile.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['f1'] } },
      data: { removed_at: now, expires_at: now, text: null },
    });
    // Its key stays: the sweep tries again.
    expect(prisma.answerFile.update).not.toHaveBeenCalled();
  });

  it('gives the analysis a file’s text in place of its id', async () => {
    const { prisma, service } = setup();
    const id = '3f2b8a1e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    prisma.answerFile.findMany.mockResolvedValue([
      { id, text: 'Licence en sciences de l’éducation' },
    ]);
    const notes = await service.notes([
      {
        label: 'Votre diplôme',
        kind: 'FILE',
        value: `${id}:diplome.pdf`,
        passed: null,
      },
      { label: 'Permis B ?', kind: 'YES_NO', value: 'yes', passed: false },
    ]);
    expect(notes).toEqual([
      {
        question: 'Votre diplôme',
        answer: 'Fichier « diplome.pdf » :\nLicence en sciences de l’éducation',
        knockoutFailed: false,
      },
      { question: 'Permis B ?', answer: 'Oui', knockoutFailed: true },
    ]);
  });
});
