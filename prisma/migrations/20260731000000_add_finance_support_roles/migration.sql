-- Lateral admin roles: they sit outside the MODERATOR/MANAGER/ADMIN/SUPER_ADMIN
-- ladder and are granted an explicit allowlist of areas instead.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'FINANCE';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'SUPPORT';
