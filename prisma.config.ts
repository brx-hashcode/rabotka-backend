import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env' });

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'tsx prisma/seed.ts',
  },
  // When running behind PgBouncer, set DATABASE_URL with ?pgbouncer=true for
  // runtime and run migrations with DATABASE_DIRECT_URL exported separately:
  //   DATABASE_URL=$DATABASE_DIRECT_URL pnpm prisma migrate deploy
  datasource: { url: process.env.DATABASE_URL },
});
