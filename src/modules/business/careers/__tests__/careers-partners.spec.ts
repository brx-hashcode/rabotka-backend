import { NotFoundException } from '@nestjs/common';
import { uniqueBusinessSlug } from '../careers-slug';
import { CareersService } from '../careers.service';
import { AdminBusinessService } from '../../admin/admin-business.service';

const companyRow = (over: Record<string, unknown>) => ({
  profile_id: 'p1',
  public_slug: 'kamoa',
  name: 'KAMOA',
  category: 'STARTUP',
  city: 'Brazzaville',
  website: null,
  description: null,
  distribute_offers: true,
  cover_url: null,
  photos: [],
  benefits: [],
  is_partner: false,
  partner_rank: null,
  profile: { avatar_url: 'https://cdn/logo.png' },
  ...over,
});

function setup() {
  const prisma = {
    jobOffer: { groupBy: jest.fn().mockResolvedValue([]) },
    business: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new CareersService(
    prisma as never,
    ...(Array.from({ length: 9 }, () => ({})) as never[]),
  );
  return { prisma, service };
}

describe('CareersService.partners', () => {
  it('lists the partners staff picked, with a logo, in their order', async () => {
    const { prisma, service } = setup();
    prisma.business.findMany.mockResolvedValue([
      {
        public_slug: 'kamoa',
        name: 'KAMOA',
        profile: { avatar_url: 'https://cdn/a.png' },
      },
    ]);

    const res = await service.partners();

    const args = prisma.business.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      is_partner: true,
      profile: { avatar_url: { not: null } },
    });
    expect(args.orderBy[0]).toEqual({
      partner_rank: { sort: 'asc', nulls: 'last' },
    });
    expect(res).toEqual([
      { slug: 'kamoa', name: 'KAMOA', logoUrl: 'https://cdn/a.png' },
    ]);
  });
});

describe('CareersService.companies', () => {
  it('puts partners first, in their order, then the most offers', async () => {
    const { prisma, service } = setup();
    prisma.jobOffer.groupBy.mockResolvedValue([
      { employer_id: 'big', _count: { _all: 9 } },
      { employer_id: 'p2', _count: { _all: 1 } },
      { employer_id: 'p1', _count: { _all: 1 } },
    ]);
    prisma.business.findMany.mockResolvedValue([
      companyRow({ profile_id: 'big', public_slug: 'big', name: 'Big' }),
      companyRow({
        profile_id: 'p2',
        public_slug: 'second',
        name: 'Second',
        is_partner: true,
        partner_rank: 2,
      }),
      companyRow({
        profile_id: 'p1',
        public_slug: 'first',
        name: 'First',
        is_partner: true,
        partner_rank: 1,
      }),
    ]);

    const res = await service.companies();

    expect(res.map((c) => c.slug)).toEqual(['first', 'second', 'big']);
    expect(res[0]).toMatchObject({
      partner: true,
      openOffers: 1,
    });
  });
});

describe('reserved slugs', () => {
  it('never hands out « offers » or « partners »', async () => {
    const tx = { business: { findMany: jest.fn().mockResolvedValue([]) } };
    await expect(uniqueBusinessSlug(tx as never, 'Offers')).resolves.toBe(
      'offers-2',
    );
    await expect(uniqueBusinessSlug(tx as never, 'Partners')).resolves.toBe(
      'partners-2',
    );
  });
});

describe('AdminBusinessService.setPartner', () => {
  function admin(found: unknown) {
    const prisma = {
      business: {
        findUnique: jest.fn().mockResolvedValue(found),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const service = Object.create(
      AdminBusinessService.prototype,
    ) as AdminBusinessService;
    Object.assign(service, { prisma });
    jest
      .spyOn(service, 'careersOf')
      .mockResolvedValue({ partner: true, partnerRank: 3 } as never);
    return { prisma, service };
  }

  it('makes it a partner with its rank', async () => {
    const { prisma, service } = admin({ id: 'b1' });
    await service.setPartner('p1', { partner: true, rank: 3 });
    expect(prisma.business.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: { is_partner: true, partner_rank: 3 },
    });
  });

  it('clears the rank when it stops being a partner', async () => {
    const { prisma, service } = admin({ id: 'b1' });
    await service.setPartner('p1', { partner: false, rank: 3 });
    expect(prisma.business.update.mock.calls[0][0].data).toEqual({
      is_partner: false,
      partner_rank: null,
    });
  });

  it('answers 404 for a profile that is not a business', async () => {
    const { service } = admin(null);
    await expect(
      service.setPartner('p1', { partner: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
