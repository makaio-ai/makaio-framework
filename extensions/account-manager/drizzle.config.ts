import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/storage/schema.ts',
  out: './src/drizzle',
  dialect: 'sqlite',
});
