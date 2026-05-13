import type { PrismaClient } from '@prisma/client';
import { UserRole } from '@prisma/client';

export async function seedSuperAdmin(prisma: PrismaClient): Promise<void> {
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;

  if (!superAdminEmail) {
    throw new Error('SUPER_ADMIN_EMAIL is not set');
  }

  const existing = await prisma.user.findUnique({
    where: { email: superAdminEmail },
  });

  if (existing) {
    console.log(
      `[Super Admin] Skipped (already exists): ${existing.first_name} ${existing.last_name} <${superAdminEmail}>`,
    );
    return;
  }

  const superAdmin = await prisma.user.create({
    data: {
      first_name: 'Rabotka',
      last_name: 'SUPER_ADMIN',
      email: superAdminEmail,
      role: UserRole.SUPER_ADMIN,
      is_active: true,
      last_login_at: null,
    },
  });

  console.log(
    `[Super Admin] Created: ${superAdmin.first_name} ${superAdmin.last_name} <${superAdmin.email}> (id: ${superAdmin.id})`,
  );
}
