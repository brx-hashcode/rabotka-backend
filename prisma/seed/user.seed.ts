import type { PrismaClient } from '@prisma/client';
import { UserRole } from '@prisma/client';

const FAKE_USERS = [
  {
    firstName: 'Alice',
    lastName: 'Johnson',
    email: 'fariol+alice.johnson@akieni.tech',
    isActive: true,
  },
  {
    firstName: 'Bob',
    lastName: 'Smith',
    email: 'fariol+bob.smith@akieni.tech',
    isActive: true,
  },

  {
    firstName: 'Charlie',
    lastName: 'Brown',
    email: 'fariol+charlie.brown@akieni.tech',
    isActive: true,
  },
] as const;

export async function seedUsers(prisma: PrismaClient): Promise<void> {
  const total = FAKE_USERS.length;
  let created = 0;
  let skipped = 0;

  for (let i = 0; i < total; i++) {
    const { firstName, lastName, email, isActive } = FAKE_USERS[i];

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      skipped++;
      console.log(
        `[${i + 1}/${total}] Skipped (already exists): ${existing.first_name} ${existing.last_name} <${email}>`,
      );
      continue;
    }

    const user = await prisma.user.create({
      data: {
        first_name: firstName,
        last_name: lastName,
        email,
        role: UserRole.ADMIN,
        is_active: isActive,
        last_login_at: null,
      },
    });

    created++;
    console.log(
      `[${i + 1}/${total}] Created user: ${user.first_name} ${user.last_name} <${user.email}> (id: ${user.id})`,
    );
  }

  console.log(
    `Seeded ${total} user(s): ${created} created, ${skipped} skipped.`,
  );
}
