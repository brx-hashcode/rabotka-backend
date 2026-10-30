import { NotFoundException } from '@nestjs/common';
import { OfferQuestionKind } from '@prisma/client';
import { slugBase, uniqueBusinessSlug } from '../careers-slug';
import { CareersService } from '../careers.service';

const business = {
  profile_id: 'p1',
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

const serviceWith = (found: unknown, offers: unknown[] = [], one?: unknown) => {
  const prisma = {
    business: { findFirst: jest.fn().mockResolvedValue(found) },
    jobOffer: {
      findMany: jest.fn().mockResolvedValue(offers),
      findFirst: jest.fn().mockResolvedValue(one ?? null),
    },
  };
  return { prisma, service: new CareersService(prisma as never) };
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
});
