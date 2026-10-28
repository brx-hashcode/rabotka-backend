import {
  AccountStatus,
  JobOfferStatus,
  PaymentFlow,
  VerificationStatus,
} from '@prisma/client';
import {
  cityFacets,
  isOpen,
  jobPostingLd,
  maskContacts,
  offerIdFromParam,
  offerPath,
  payLabel,
  publicEmployer,
  slugify,
  validThrough,
} from '../job-page-model';
import { row } from './offer-row.fixture';

const ID = 'a2a59adb-b517-48af-ab5c-b5cff8aa5529';
const NOW = new Date('2026-10-28T12:00:00Z');

describe('job page model', () => {
  it('slugifies French words', () => {
    expect(slugify('Pointe-Noire')).toBe('pointe-noire');
    expect(slugify('Électricité & Froid ')).toBe('electricite-froid');
    expect(slugify("Agent d'entretien")).toBe('agent-d-entretien');
  });

  it('builds the offer path from title and city, once', () => {
    expect(offerPath(row())).toBe(
      `/emplois/offre/chauffeur-livreur-brazzaville-${ID}`,
    );
    expect(offerPath(row({ title: 'Agent de Brazzaville' }))).toBe(
      `/emplois/offre/agent-de-brazzaville-${ID}`,
    );
    expect(offerPath(row({ is_remote: true }))).toBe(
      `/emplois/offre/chauffeur-livreur-${ID}`,
    );
  });

  it('reads the id back from any words', () => {
    expect(offerIdFromParam(`anything-${ID.toUpperCase()}`)).toBe(ID);
    expect(offerIdFromParam('no-id-here')).toBeNull();
  });

  it('falls back to the employer city, never for a remote job', () => {
    expect(offerPath(row({ city: null }))).toContain('pointe-noire');
  });

  it('shows a verified business, hides anyone else', () => {
    expect(publicEmployer(row())).toEqual({
      name: 'ZuaFood',
      logoUrl: 'https://cdn.example/logo.png',
      verifiedBusiness: true,
    });
    const pending = row();
    pending.employer.business!.verification_status = VerificationStatus.PENDING;
    expect(publicEmployer(pending)).toMatchObject({
      name: 'Entreprise',
      logoUrl: null,
    });
    const person = row();
    person.employer.is_business = false;
    expect(publicEmployer(person)).toMatchObject({
      name: 'Employeur particulier',
      logoUrl: null,
    });
  });

  it('masks contact details in the description', () => {
    const masked = maskContacts(
      'Appelez le 06 991 66 44 ou écrivez à jean@exemple.cg merci',
    );
    expect(masked).not.toMatch(/991|jean@/);
    expect(masked).toContain('[coordonnées masquées]');
    expect(masked).toMatch(/^Appelez le .* merci$/);
  });

  it('labels the pay, or none when it is to be agreed', () => {
    expect(payLabel(row())).toMatch(/^10\s000 FCFA par jour$/);
    expect(payLabel(row({ amount: null }))).toBeNull();
  });

  it('closes on the date, or 30 days after posting without one', () => {
    expect(validThrough(row())).toEqual(new Date('2026-11-05T08:00:00Z'));
    expect(validThrough(row({ scheduled_at: null }))).toEqual(
      new Date('2026-11-19T08:00:00Z'),
    );
  });

  it('is open only while active, before its date, from an active employer', () => {
    expect(isOpen(row(), NOW)).toBe(true);
    expect(isOpen(row({ status: JobOfferStatus.FILLED }), NOW)).toBe(false);
    expect(
      isOpen(row({ scheduled_at: new Date('2026-10-27T00:00:00Z') }), NOW),
    ).toBe(false);
    const banned = row();
    banned.employer.status = AccountStatus.BANNED;
    expect(isOpen(banned, NOW)).toBe(false);
  });

  it('writes a JobPosting with no contact detail', () => {
    const ld = jobPostingLd(
      row({ description: 'Contact : 06 991 66 44\nMerci <b>', quantity: 3 }),
      'https://rabotka.work',
    );
    expect(ld).toMatchObject({
      '@type': 'JobPosting',
      title: 'Chauffeur livreur',
      employmentType: ['TEMPORARY'],
      hiringOrganization: {
        name: 'ZuaFood',
        logo: 'https://cdn.example/logo.png',
      },
      jobLocation: {
        address: { addressLocality: 'Brazzaville', addressCountry: 'CG' },
      },
      baseSalary: { currency: 'XAF', value: { value: 10000, unitText: 'DAY' } },
      totalJobOpenings: 3,
      directApply: false,
      url: `https://rabotka.work/emplois/offre/chauffeur-livreur-brazzaville-${ID}`,
    });
    expect(ld.description).not.toContain('991');
    expect(ld.description).toContain('<br>Merci &lt;b&gt;');
  });

  it('leaves the salary out for a fixed price, and marks remote jobs', () => {
    const ld = jobPostingLd(
      row({ payment_flow: PaymentFlow.TASK, is_remote: true }),
      'https://rabotka.work',
    );
    expect(ld).not.toHaveProperty('baseSalary');
    expect(ld).not.toHaveProperty('jobLocation');
    expect(ld).toMatchObject({ jobLocationType: 'TELECOMMUTE' });
  });

  it('groups city spellings under one slug, busiest first', () => {
    const facets = cityFacets([
      'Pointe-Noire',
      'pointe noire',
      'Pointe-Noire',
      'Dolisie',
      null,
      ' ',
    ]);
    expect(facets).toEqual([
      {
        slug: 'pointe-noire',
        name: 'Pointe-Noire',
        count: 3,
        spellings: ['Pointe-Noire', 'pointe noire'],
      },
      { slug: 'dolisie', name: 'Dolisie', count: 1, spellings: ['Dolisie'] },
    ]);
  });
});
