import { ConflictException, NotFoundException } from '@nestjs/common';
import { ShortlistService } from '../shortlist.service';

function make() {
  const prisma: any = {
    application: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    externalApplication: {
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    jobOffer: { findFirst: jest.fn().mockResolvedValue({ id: 'o1' }) },
  };
  return { service: new ShortlistService(prisma), prisma };
}

describe('ShortlistService.set', () => {
  it('shortlists a waiting Rabotka candidature of this business, and takes it off', async () => {
    const { service, prisma } = make();
    prisma.application.findFirst.mockResolvedValue({
      status: 'VIEWED',
      shortlisted_at: null,
    });

    const on = await service.set('biz', 'rabotka', 'a1', true);
    expect(on.shortlisted).toBe(true);
    expect(prisma.application.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'a1',
      job_offer: { employer_id: 'biz' },
    });
    expect(
      prisma.application.update.mock.calls[0][0].data.shortlisted_at,
    ).toBeInstanceOf(Date);

    const off = await service.set('biz', 'rabotka', 'a1', false);
    expect(off).toEqual({ shortlisted: false, shortlistedAt: null });
    expect(prisma.application.update.mock.calls[1][0].data).toEqual({
      shortlisted_at: null,
    });
  });

  it('keeps the first date when shortlisted twice', async () => {
    const { service, prisma } = make();
    const first = new Date('2026-11-01T08:00:00Z');
    prisma.externalApplication.findFirst.mockResolvedValue({
      status: 'PENDING',
      shortlisted_at: first,
    });
    await expect(service.set('biz', 'external', 'e1', true)).resolves.toEqual({
      shortlisted: true,
      shortlistedAt: first.toISOString(),
    });
    expect(prisma.externalApplication.update).not.toHaveBeenCalled();
  });

  it('refuses a decided candidature, and one of another business', async () => {
    const { service, prisma } = make();
    prisma.externalApplication.findFirst.mockResolvedValueOnce({
      status: 'RETAINED',
      shortlisted_at: null,
    });
    await expect(
      service.set('biz', 'external', 'e1', true),
    ).rejects.toBeInstanceOf(ConflictException);

    prisma.application.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.set('other', 'rabotka', 'a1', true),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ShortlistService.bulk', () => {
  it('changes only waiting candidatures of the offer, keeping dates already set', async () => {
    const { service, prisma } = make();
    prisma.application.updateMany.mockResolvedValue({ count: 2 });
    prisma.externalApplication.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.bulk('biz', 'o1', {
        rabotka: ['a1', 'a2', 'a3'],
        external: ['e1'],
        shortlisted: true,
      }),
    ).resolves.toEqual({ changed: 3, skipped: 1 });
    expect(prisma.jobOffer.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'o1',
      employer_id: 'biz',
    });
    expect(prisma.application.updateMany.mock.calls[0][0].where).toMatchObject({
      job_offer_id: 'o1',
      status: { in: ['PENDING', 'VIEWED'] },
      shortlisted_at: null,
    });
    expect(
      prisma.externalApplication.updateMany.mock.calls[0][0].where,
    ).toMatchObject({ status: { in: ['PENDING'] }, shortlisted_at: null });
  });

  it('takes off without a date condition, and refuses another business', async () => {
    const { service, prisma } = make();
    await service.bulk('biz', 'o1', { external: ['e1'], shortlisted: false });
    const where = prisma.externalApplication.updateMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('shortlisted_at');
    expect(prisma.application.updateMany).not.toHaveBeenCalled();

    prisma.jobOffer.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.bulk('other', 'o1', { rabotka: ['a1'], shortlisted: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
