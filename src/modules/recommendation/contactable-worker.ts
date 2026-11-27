import {
  AccountStatus,
  type Prisma,
  ProfileType,
  VerificationStatus,
} from '@prisma/client';

/**
 * Who an employer may pay to reach through a recommendation: an active,
 * verified, non-archived WORKER.
 *
 * One predicate for both ends of the purchase — the wallet path and the
 * mobile-money link check it before charging, and the mobile-money settlement
 * checks it again before delivering the contact, since a link can be paid long
 * after it was created. Pentest A2-F09 (#865): the creation check had no
 * profile_type or deleted_at, so an employer's or an archived worker's phone
 * could be bought. A2-F18 (#874): delivery did not check at all.
 */
export const CONTACTABLE_WORKER: Prisma.ProfileWhereInput = {
  profile_type: ProfileType.WORKER,
  status: AccountStatus.ACTIVE,
  verification_status: VerificationStatus.VERIFIED,
  deleted_at: null,
};

/**
 * A worker whose contact an employer that holds it may still read: not
 * archived, not banned. A suspension is temporary and keeps the contact.
 * Paying once is not a permanent window onto someone the platform removed
 * (pentest A2-NV04, #880; security audit run 2 for the business routes).
 */
export const KEPT_CONTACT: Prisma.ProfileWhereInput = {
  deleted_at: null,
  status: { not: AccountStatus.BANNED },
};
