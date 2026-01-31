import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env' });

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://postgres:postgres@localhost:5433/rabotka',
  },
});
