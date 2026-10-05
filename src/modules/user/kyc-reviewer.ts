import { UserRole } from '@prisma/client';

/**
 * Roles that can sit in the KYC verification group.
 *
 * The group is picked person by person, so a role never puts anyone in it;
 * this only keeps out people who could open the email and then not act on it.
 * It mirrors who passes `PATCH admin/profiles/:id/verify`: `@Roles(MANAGER)`
 * and above, plus SUPPORT and FINANCE through their `admin/profiles: 'full'`
 * lateral access. MODERATOR is below MANAGER with no lateral grant.
 */
export const KYC_REVIEWER_ROLES: readonly UserRole[] = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.MANAGER,
  UserRole.SUPPORT,
  UserRole.FINANCE,
];

export function canReviewKyc(role: UserRole): boolean {
  return KYC_REVIEWER_ROLES.includes(role);
}
