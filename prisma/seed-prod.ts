import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { seedSuperAdmin } from './seed/user.seed';
import { seedJobCategories } from './seed/job-category.seed';

config({ path: '.env.local' });
config({ path: '.env' });

const connectionString = process.env.DATABASE_URL;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

void run();

async function run() {
  try {
    await seedJobCategories(prisma);
    await seedSuperAdmin(prisma);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
