import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

const FULL_CONTEXT_DESCRIPTION =
  'This is the curated full developer documentation for Makaio Framework. It combines guides, package overviews, and SDK docs for large context windows and documentation review. Generated API Reference and Bus Subjects are intentionally excluded; fetch their dedicated LLM sets when you need exact TypeScript symbols or bus subject contracts.';

const INPUT_SETS = [
  { label: 'Guides', file: '_llms-txt/guides.txt' },
  { label: 'Packages', file: '_llms-txt/packages.txt' },
  { label: 'SDKs', file: '_llms-txt/sdks.txt' },
] as const;

/**
 * Removes the leading starlight-llms-txt SYSTEM banner from a generated set.
 * @param content - Generated LLM text content.
 * @returns Content without the leading SYSTEM banner.
 */
export function stripSystemBanner(content: string): string {
  return content.replace(/^<SYSTEM>[\s\S]*?<\/SYSTEM>\s*/, '').trim();
}

/**
 * Composes the curated full LLM document from already-generated set files.
 * @param readSet - Reads a generated set file by relative path.
 * @returns Curated full LLM text.
 */
export function composeLlmsFull(readSet: (relativePath: string) => string): string {
  const sections = INPUT_SETS.map(({ label, file }) => {
    const content = stripSystemBanner(readSet(file));
    if (content.startsWith(`# ${label}\n`)) return content;
    return `# ${label}\n\n${content}`;
  });

  return [`<SYSTEM>${FULL_CONTEXT_DESCRIPTION}</SYSTEM>`, ...sections].join('\n\n');
}

/**
 * Replaces starlight-llms-txt's unbounded full dump with a curated large-context document.
 * @returns Astro integration that writes `llms-full.txt` after route generation.
 */
export function composeLlmsFullIntegration(): AstroIntegration {
  return {
    name: 'compose-llms-full',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        const outputRoot = fileURLToPath(dir);
        const fullPath = path.join(outputRoot, 'llms-full.txt');
        const body = composeLlmsFull((relativePath) => {
          const inputPath = path.join(outputRoot, relativePath);
          return fs.readFileSync(inputPath, 'utf-8');
        });

        fs.writeFileSync(fullPath, `${body}\n`);
        logger.info('Wrote curated llms-full.txt from Guides, Packages, and SDKs.');
      },
    },
  };
}
