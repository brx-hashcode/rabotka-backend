import {
  describeJobOfferChanges,
  joinFrench,
  JobOfferTerms,
} from '../utils/job-offer-changes.util';

const base: JobOfferTerms = {
  amount: 15000,
  scheduled_at: new Date('2026-11-01T09:00:00Z'),
  is_remote: false,
  address: '12 avenue de la Paix',
  city: 'Brazzaville',
  country_code: 'CG',
};

describe('describeJobOfferChanges', () => {
  it('reports nothing when the terms are the same', () => {
    expect(
      describeJobOfferChanges(base, {
        ...base,
        scheduled_at: new Date(base.scheduled_at!.getTime()),
      }),
    ).toEqual([]);
  });

  it('names each material change', () => {
    expect(
      describeJobOfferChanges(base, {
        ...base,
        amount: 20000,
        scheduled_at: new Date('2026-11-02T09:00:00Z'),
        city: 'Pointe-Noire',
      }),
    ).toEqual(['la rémunération', 'la date', 'le lieu']);
  });

  it('treats going remote as a change of place', () => {
    expect(
      describeJobOfferChanges(base, {
        ...base,
        is_remote: true,
        address: null,
        city: null,
        country_code: null,
      }),
    ).toEqual(['le lieu']);
  });

  it('treats adding or removing an amount as a change', () => {
    expect(describeJobOfferChanges(base, { ...base, amount: null })).toEqual([
      'la rémunération',
    ]);
  });
});

describe('joinFrench', () => {
  it('joins like a French sentence', () => {
    expect(joinFrench(['la date'])).toBe('la date');
    expect(joinFrench(['la date', 'le lieu'])).toBe('la date et le lieu');
    expect(joinFrench(['la rémunération', 'la date', 'le lieu'])).toBe(
      'la rémunération, la date et le lieu',
    );
    expect(joinFrench([])).toBe('les conditions');
  });
});
