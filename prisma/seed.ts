import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, UserRole } from '../src/generated/prisma/client';

config({ path: '.env.local' });
config({ path: '.env' });

const connectionString = process.env.DATABASE_URL;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

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

async function main() {
  const total = FAKE_USERS.length;
  let created = 0;
  let skipped = 0;

  for (let i = 0; i < total; i++) {
    const { firstName, lastName, email, isActive } = FAKE_USERS[i];

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      skipped++;
      console.log(
        `[${i + 1}/${total}] Skipped (already exists): ${existing.firstName} ${existing.lastName} <${email}>`,
      );
      continue;
    }

    const user = await prisma.user.create({
      data: {
        firstName,
        lastName,
        email,
        role: UserRole.ADMIN,
        isActive,
        lastLoginAt: null,
      },
    });

    created++;
    console.log(
      `[${i + 1}/${total}] Created user: ${user.firstName} ${user.lastName} <${user.email}> (id: ${user.id})`,
    );
  }

  console.log(
    `Seeded ${total} user(s): ${created} created, ${skipped} skipped.`,
  );
}

void run();

async function run() {
  try {
    await main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
