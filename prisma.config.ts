import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env' });

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL,
    // Used by prisma migrate deploy to bypass PgBouncer (transaction mode
    // breaks prepared statements). Falls back to DATABASE_URL when not set.
    directUrl: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
