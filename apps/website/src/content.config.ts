import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { generateWebsiteDocsId } from './content-route-id';

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: '../..',
      pattern: ['docs/**/*.{md,mdx}', '!docs/subjects/**', 'apps/website/src/content/docs/**/*.{md,mdx}'],
      generateId: generateWebsiteDocsId,
    }),
    schema: docsSchema(),
  }),
};
