import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration for review extension storage migrations.
 */
export default defineConfig({
  schema: './src/storage/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
});
