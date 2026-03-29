import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { seedSuperAdmin } from './seed/user.seed';
import { seedClaims } from './seed/claims.seed';
import { seedProfiles } from './seed/profile.seed';
import { seedJobOffersAndApplications } from './seed/job-offer.seed';
import { seedPenalties } from './seed/penalty.seed';

config({ path: '.env.local' });
config({ path: '.env' });

const connectionString = process.env.DATABASE_URL;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

void run();

async function run() {
  try {
    await seedSuperAdmin(prisma);
    await seedProfiles(prisma);
    await seedJobOffersAndApplications(prisma);
    await seedPenalties(prisma);
    await seedClaims(prisma);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
