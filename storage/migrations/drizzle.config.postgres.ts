import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './.generated/schema.postgres.ts',
  out: './drizzle-postgres',
  dialect: 'postgresql',
});
