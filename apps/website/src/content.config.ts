import fs from 'node:fs';
import path from 'node:path';
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { generateWebsiteDocsId } from './content-route-id';

const frameworkRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const gitignoreExcludes = fs
  .readFileSync(path.join(frameworkRoot, '.gitignore'), 'utf-8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
  .map((p) => `!${p.replace(/\/$/u, '')}/**`);

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: '../..',
      pattern: [
        'docs/**/*.{md,mdx}',
        '!docs/subjects/**',
        ...gitignoreExcludes,
        'apps/website/src/content/docs/**/*.{md,mdx}',
        '!apps/website/.astro/**',
      ],
      generateId: generateWebsiteDocsId,
    }),
    schema: docsSchema(),
  }),
};
