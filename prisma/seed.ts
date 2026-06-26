import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { seedSuperAdmin } from './seed/user.seed';
import { seedClaims } from './seed/claims.seed';
import { seedProfiles } from './seed/profile.seed';
import { seedJobOffersAndApplications } from './seed/job-offer.seed';
import { seedResumeTest } from './seed/resume-test.seed';
import { seedPenalties } from './seed/penalty.seed';
import { seedInvoices } from './seed/invoice.seed';
import { seedJobCategories } from './seed/job-category.seed';
import { seedMobileMoneyWallet } from './seed/mobile-money-wallet.seed';
import { seedSystemConfig } from './seed/system-config.seed';

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
    await seedSystemConfig(prisma);
    await seedProfiles(prisma);
    await seedJobOffersAndApplications(prisma);
    await seedResumeTest(prisma);
    await seedPenalties(prisma);
    await seedClaims(prisma);
    await seedInvoices(prisma);
    await seedMobileMoneyWallet(prisma);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
