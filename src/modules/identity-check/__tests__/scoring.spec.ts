import {
  AccountStatus,
  DocumentType,
  VerificationStatus,
} from '@prisma/client';
import { jaroWinkler } from '../scoring/jaro-winkler';
import { matchName } from '../scoring/name-match';
import { scoreIdentity, type StoredIdentity } from '../scoring/score';

const stored = (overrides: Partial<StoredIdentity> = {}): StoredIdentity => ({
  firstName: 'Jean',
  lastName: 'Mabiala',
  countryCode: 'CG',
  city: 'Brazzaville',
  documentType: DocumentType.IDENTITY_CARD,
  verificationStatus: VerificationStatus.VERIFIED,
  verifiedAt: new Date('2026-05-01T10:00:00.000Z'),
  accountStatus: AccountStatus.ACTIVE,
  ...overrides,
});

describe('jaroWinkler', () => {
  it('is 1 for identical words and 0 for nothing in common', () => {
    expect(jaroWinkler('mabiala', 'mabiala')).toBe(1);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
    expect(jaroWinkler('', '')).toBe(0);
  });

  it('matches the textbook value for MARTHA / MARHTA', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
  });
});

describe('matchName', () => {
  const name = (firstName: string, lastName: string) => ({
    firstName,
    lastName,
  });

  it('is strong for the exact name', () => {
    expect(matchName(name('Jean', 'Mabiala'), name('Jean', 'Mabiala'))).toEqual(
      { level: 'strong', score: 100 },
    );
  });

  it('ignores accents, case and punctuation', () => {
    const result = matchName(
      name('ÉLODIE', 'Ngoma-Bouanga'),
      name('Elodie', 'Ngoma Bouanga'),
    );
    expect(result).toEqual({ level: 'strong', score: 100 });
  });

  it('accepts first and last name swapped', () => {
    expect(
      matchName(name('Mabiala', 'Jean'), name('Jean', 'Mabiala')).level,
    ).toBe('strong');
  });

  it('stays strong when the partner omits a middle name', () => {
    const result = matchName(
      name('Jean', 'Mabiala'),
      name('Jean', 'Mabiala Nkounkou'),
    );
    expect(result.level).toBe('strong');
    expect(result.score).toBeLessThan(100);
  });

  it('is only partial for a lone first name', () => {
    expect(matchName(name('Jean', ''), name('Jean', 'Mabiala')).level).toBe(
      'partial',
    );
  });

  it('tolerates a one-letter spelling slip', () => {
    expect(
      matchName(name('Jean', 'Mabialah'), name('Jean', 'Mabiala')).level,
    ).toBe('strong');
  });

  it('is none for a different person', () => {
    expect(matchName(name('Paul', 'Okemba'), name('Jean', 'Mabiala'))).toEqual({
      level: 'none',
      score: 0,
    });
  });

  it('does not let one stored word satisfy two claimed words', () => {
    const result = matchName(name('Jean', 'Jean'), name('Jean', 'Mabiala'));
    expect(result.level).not.toBe('strong');
  });
});

describe('scoreIdentity', () => {
  it('accepts a verified person whose claim agrees in full', () => {
    const result = scoreIdentity(
      {
        firstName: 'Jean',
        lastName: 'Mabiala',
        countryCode: 'cg',
        city: 'brazzaville',
        documentType: DocumentType.IDENTITY_CARD,
      },
      stored(),
    );

    expect(result).toEqual({
      kyc: {
        status: 'verified',
        verified_at: '2026-05-01T10:00:00.000Z',
        account_status: 'active',
      },
      match: {
        phone: 'match',
        name: { level: 'strong', score: 100 },
        country: 'match',
        city: 'match',
        document_type: 'match',
      },
      score: 100,
      recommendation: 'accept',
    });
  });

  it('leaves fields the partner did not send out of the score', () => {
    const result = scoreIdentity(
      { firstName: 'Jean', lastName: 'Mabiala' },
      stored(),
    );
    expect(result.match.country).toBe('unknown');
    expect(result.match.city).toBe('unknown');
    expect(result.match.document_type).toBe('unknown');
    expect(result.score).toBe(100);
  });

  it('treats a field the profile lacks as unknown, not a mismatch', () => {
    const result = scoreIdentity(
      { firstName: 'Jean', lastName: 'Mabiala', city: 'Brazzaville' },
      stored({ city: null }),
    );
    expect(result.match.city).toBe('unknown');
    expect(result.score).toBe(100);
  });

  it('lowers the score for a mismatching country', () => {
    const result = scoreIdentity(
      { firstName: 'Jean', lastName: 'Mabiala', countryCode: 'CM' },
      stored(),
    );
    expect(result.match.country).toBe('mismatch');
    expect(result.score).toBe(82);
    expect(result.recommendation).toBe('review');
  });

  it('matches a city despite hyphens and accents', () => {
    const result = scoreIdentity(
      { firstName: 'Jean', lastName: 'Mabiala', city: 'Pointe-Noire' },
      stored({ city: 'Pointe Noire' }),
    );
    expect(result.match.city).toBe('match');
  });

  it('never accepts while KYC is still pending', () => {
    const result = scoreIdentity(
      { firstName: 'Jean', lastName: 'Mabiala' },
      stored({
        verificationStatus: VerificationStatus.PENDING,
        verifiedAt: null,
      }),
    );
    expect(result.kyc.status).toBe('pending');
    expect(result.recommendation).toBe('review');
  });

  it.each([
    ['a refused KYC', { verificationStatus: VerificationStatus.REJECTED }],
    ['a suspended account', { accountStatus: AccountStatus.SUSPENDED }],
  ])('rejects %s whatever the name says', (_label, overrides) => {
    const result = scoreIdentity(
      { firstName: 'Jean', lastName: 'Mabiala' },
      stored(overrides),
    );
    expect(result.score).toBe(100);
    expect(result.recommendation).toBe('reject');
  });

  it('rejects when the name does not match, even if the rest does', () => {
    const result = scoreIdentity(
      {
        firstName: 'Paul',
        lastName: 'Okemba',
        countryCode: 'CG',
        city: 'Brazzaville',
      },
      stored(),
    );
    expect(result.match.name.level).toBe('none');
    expect(result.recommendation).toBe('reject');
  });

  it('never echoes the stored name back', () => {
    const result = scoreIdentity(
      { firstName: 'Paul', lastName: 'Okemba' },
      stored(),
    );
    expect(JSON.stringify(result)).not.toMatch(/jean|mabiala|brazzaville/i);
  });
});
