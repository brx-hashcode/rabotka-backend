import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { seedProfiles } from './seed/profile.seed';
import { seedSuperAdmin } from './seed/user.seed';
import { seedWallet } from './seed/wallet.seed';

config({ path: '.env.local' });
config({ path: '.env' });

const connectionString = process.env.DATABASE_URL;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

void run();

async function run() {
  try {
    await seedSuperAdmin(prisma);
    // await seedUsers(prisma);
    await seedProfiles(prisma);
    await seedWallet(prisma);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
