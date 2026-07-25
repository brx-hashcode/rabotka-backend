/**
 * Prisma `deleted_at` filter for admin lists that support a "show archived"
 * toggle. Default (false) hides soft-deleted rows; true shows only archived
 * rows. Dashboards and non-admin surfaces keep hardcoding `deleted_at: null`.
 */
export function deletedAtFilter(showDeleted?: boolean): { not: null } | null {
  return showDeleted ? { not: null } : null;
}
