import {
  AccountStatus,
  DocumentType,
  VerificationStatus,
} from '@prisma/client';
import { foldText } from '../../rag/shared/text';
import { jaroWinkler } from './jaro-winkler';
import { matchName, type NameMatch } from './name-match';

export type ClaimedIdentity = {
  firstName: string;
  lastName: string;
  countryCode?: string | null;
  city?: string | null;
  documentType?: DocumentType | null;
};

export type StoredIdentity = {
  firstName: string;
  lastName: string;
  countryCode: string | null;
  city: string | null;
  documentType: DocumentType | null;
  verificationStatus: VerificationStatus;
  verifiedAt: Date | null;
  accountStatus: AccountStatus;
};

export type FieldMatch = 'match' | 'mismatch' | 'unknown';

export type Recommendation = 'accept' | 'review' | 'reject';

export type IdentityCheckResult = {
  kyc: {
    status: 'verified' | 'pending' | 'rejected';
    verified_at: string | null;
    account_status: 'active' | 'pending_activation' | 'suspended' | 'banned';
  };
  match: {
    phone: 'match';
    name: NameMatch;
    country: FieldMatch;
    city: FieldMatch;
    document_type: FieldMatch;
  };
  score: number;
  recommendation: Recommendation;
};

const WEIGHTS = {
  name: 70,
  country: 15,
  city: 10,
  documentType: 5,
} as const;

export const ACCEPT_SCORE = 85;
export const REVIEW_SCORE = 60;

const CITY_FLOOR = 0.9;

export function scoreIdentity(
  claimed: ClaimedIdentity,
  stored: StoredIdentity,
): IdentityCheckResult {
  const name = matchName(claimed, stored);
  const country = compareCountry(claimed.countryCode, stored.countryCode);
  const city = compareCity(claimed.city, stored.city);
  const documentType = compareExact(claimed.documentType, stored.documentType);

  const parts: { weight: number; value: number }[] = [
    { weight: WEIGHTS.name, value: name.score / 100 },
  ];
  addField(parts, WEIGHTS.country, country);
  addField(parts, WEIGHTS.city, city);
  addField(parts, WEIGHTS.documentType, documentType);

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const score = Math.round(
    (100 * parts.reduce((sum, p) => sum + p.weight * p.value, 0)) / totalWeight,
  );

  return {
    kyc: {
      status: kycStatus(stored.verificationStatus),
      verified_at: stored.verifiedAt?.toISOString() ?? null,
      account_status: accountStatus(stored.accountStatus),
    },
    match: {
      phone: 'match',
      name,
      country,
      city,
      document_type: documentType,
    },
    score,
    recommendation: recommend(score, name, stored),
  };
}

function recommend(
  score: number,
  name: NameMatch,
  stored: StoredIdentity,
): Recommendation {
  if (
    stored.verificationStatus === VerificationStatus.REJECTED ||
    stored.accountStatus === AccountStatus.SUSPENDED ||
    stored.accountStatus === AccountStatus.BANNED ||
    name.level === 'none'
  ) {
    return 'reject';
  }

  if (
    stored.verificationStatus === VerificationStatus.VERIFIED &&
    score >= ACCEPT_SCORE
  ) {
    return 'accept';
  }

  return score >= REVIEW_SCORE ? 'review' : 'reject';
}

function addField(
  parts: { weight: number; value: number }[],
  weight: number,
  match: FieldMatch,
): void {
  if (match === 'unknown') return;
  parts.push({ weight, value: match === 'match' ? 1 : 0 });
}

function compareCountry(
  claimed: string | null | undefined,
  stored: string | null,
): FieldMatch {
  const a = claimed?.trim().toUpperCase();
  const b = stored?.trim().toUpperCase();
  if (!a || !b) return 'unknown';
  return a === b ? 'match' : 'mismatch';
}

function compareCity(
  claimed: string | null | undefined,
  stored: string | null,
): FieldMatch {
  const a = claimed ? foldText(claimed) : '';
  const b = stored ? foldText(stored) : '';
  if (!a || !b) return 'unknown';
  return jaroWinkler(a, b) >= CITY_FLOOR ? 'match' : 'mismatch';
}

function compareExact<T>(
  claimed: T | null | undefined,
  stored: T | null,
): FieldMatch {
  if (claimed == null || stored == null) return 'unknown';
  return claimed === stored ? 'match' : 'mismatch';
}

function kycStatus(
  status: VerificationStatus,
): IdentityCheckResult['kyc']['status'] {
  switch (status) {
    case VerificationStatus.VERIFIED:
      return 'verified';
    case VerificationStatus.REJECTED:
      return 'rejected';
    default:
      return 'pending';
  }
}

function accountStatus(
  status: AccountStatus,
): IdentityCheckResult['kyc']['account_status'] {
  return status.toLowerCase() as IdentityCheckResult['kyc']['account_status'];
}
