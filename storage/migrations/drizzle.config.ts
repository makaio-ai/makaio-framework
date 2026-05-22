import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './.generated/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
});
