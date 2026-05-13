import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { seedJobCategories } from './seed/job-category.seed';
import { seedRecommendationTest } from './seed/recommendation-test.seed';

config({ path: '.env.local' });
config({ path: '.env' });

const connectionString = process.env.DATABASE_URL;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

void run();

async function run() {
  try {
    // Categories must exist before profiles reference them
    await seedJobCategories(prisma);
    await seedRecommendationTest(prisma);
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}
