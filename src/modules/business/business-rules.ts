import { BadRequestException } from '@nestjs/common';
import { ProfileType } from '@prisma/client';

/**
 * Only an employer can be a business. The database enforces the same rule
 * (CHECK profiles_business_is_employer) — this is the readable 400 in front
 * of its opaque failure.
 */
export function assertBusinessIsEmployer(
  profileType: ProfileType,
  isBusiness: boolean,
): void {
  if (isBusiness && profileType !== ProfileType.EMPLOYER) {
    throw new BadRequestException(
      'Un compte entreprise est forcément un recruteur. Retirez d’abord le compte entreprise.',
    );
  }
}

/** Whether a profile may use the business dashboard. */
export function isBusinessEmployer(profile: {
  profile_type: ProfileType;
  is_business: boolean;
  deleted_at: Date | null;
  business: { deleted_at: Date | null } | null;
}): boolean {
  return (
    profile.profile_type === ProfileType.EMPLOYER &&
    profile.is_business &&
    profile.deleted_at === null &&
    profile.business !== null &&
    profile.business.deleted_at === null
  );
}
