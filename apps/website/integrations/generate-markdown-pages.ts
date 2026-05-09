import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { remarkStripMdLinks } from '../remark/strip-md-links';
import { remarkStripJsx } from '../remark/strip-jsx';
import { remarkWebHide } from '../remark/web-hide';
import { remarkAutoLinkApi } from '../remark/auto-link-api';
import { remarkAutoLinkPackages, type RemarkAutoLinkPackagesOptions } from '../remark/auto-link-packages';
import { generateWebsiteDocsId } from '../src/content-route-id';

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

const FRAMEWORK_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OVERRIDES_DIR = path.resolve(import.meta.dirname, '..', 'src/content/markdown-overrides');

/** Content glob sources matching the content.config.ts loader. */
const CONTENT_GLOBS = [
  { base: path.join(FRAMEWORK_ROOT, 'docs'), prefix: 'docs/', exclude: /^subjects\// },
  { base: path.join(FRAMEWORK_ROOT, 'apps/website/src/content/docs'), prefix: 'apps/website/src/content/docs/' },
];

/**
 * Strips YAML frontmatter from a Markdown file body.
 * @param raw - Raw file content including frontmatter.
 * @returns Markdown body without the leading `---` block.
 */
export function stripFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, '').trimStart();
}

/**
 * Builds the unified remark pipeline that mirrors the website's markdown transforms.
 * @param packageOptions - Options for the auto-link-packages remark plugin.
 * @returns Configured unified processor.
 */
export function buildRemarkPipeline(packageOptions: RemarkAutoLinkPackagesOptions) {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkStripMdLinks)
    .use(remarkStripJsx)
    .use(remarkWebHide)
    .use(remarkAutoLinkApi)
    .use(remarkAutoLinkPackages, packageOptions)
    .use(remarkStringify, { bullet: '-', emphasis: '_', strong: '*', rule: '-' });
}

/**
 * Transforms a raw markdown body through the website's remark pipeline.
 * @param body - Markdown body without frontmatter.
 * @param pipeline - Pre-built unified pipeline.
 * @returns Transformed markdown string.
 */
export async function processMarkdownBody(
  body: string,
  pipeline: ReturnType<typeof buildRemarkPipeline>,
): Promise<string> {
  const result = await pipeline.process(body);
  return String(result).trim();
}

interface ContentEntry {
  /** Route ID (e.g. `guides/bus` or `why`). */
  routeId: string;
  /** Absolute path to the source file. */
  filePath: string;
}

/**
 * Discovers all content entries from the same sources as the content collection loader.
 * @returns Content entries with route IDs and file paths.
 */
function discoverContentEntries(): ContentEntry[] {
  const entries: ContentEntry[] = [];

  for (const source of CONTENT_GLOBS) {
    if (!fs.existsSync(source.base)) continue;
    walkDir(source.base, '', (relativePath) => {
      if (!/\.(md|mdx)$/u.test(relativePath)) return;
      if (source.exclude?.test(relativePath)) return;

      const entryKey = source.prefix + relativePath;
      try {
        const routeId = generateWebsiteDocsId({ entry: entryKey });
        entries.push({ routeId, filePath: path.join(source.base, relativePath) });
      } catch {
        // Entry path not supported by the route ID generator — skip.
      }
    });
  }

  return entries;
}

/**
 * Recursively walks a directory, calling the visitor with each relative path.
 * @param base - Root directory.
 * @param relative - Current path relative to base.
 * @param visitor - Called with each file's relative path.
 */
function walkDir(base: string, relative: string, visitor: (relativePath: string) => void): void {
  const dir = path.join(base, relative);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkDir(base, childRelative, visitor);
    } else {
      visitor(childRelative);
    }
  }
}

/**
 * Checks for an override markdown file for the given route.
 * @param routeId - Normalized route ID (e.g. `guides/bus` or `index`).
 * @returns Absolute path to the override file, or `undefined` if none exists.
 */
export function resolveOverride(routeId: string): string | undefined {
  const overridePath = path.join(OVERRIDES_DIR, `${routeId}.md`);
  return fs.existsSync(overridePath) ? overridePath : undefined;
}

/**
 * Post-build integration that generates per-page `.md` files in `dist/` alongside
 * the HTML output. Each markdown file has the website's remark transforms applied
 * (link normalization, JSX stripping, web:hide removal, API and package auto-linking).
 *
 * Pages can be overridden by placing a `.md` file in
 * `src/content/markdown-overrides/{routeId}.md`. Override files are still run
 * through the remark pipeline for auto-linking.
 *
 * Enables LLMs to fetch `/{route}.md` for a remark-transformed markdown version
 * of any documentation page.
 * @param packageOptions - Options for the auto-link-packages remark plugin.
 * @returns Astro integration.
 */
export function generateMarkdownPages(packageOptions: RemarkAutoLinkPackagesOptions): AstroIntegration {
  return {
    name: 'generate-markdown-pages',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const outputRoot = fileURLToPath(dir);
        const pipeline = buildRemarkPipeline(packageOptions);
        const entries = discoverContentEntries();

        let written = 0;
        let overridden = 0;
        for (const entry of entries) {
          const routeNormalized = entry.routeId.replace(/\/index$/, '');
          const outputPath = routeNormalized
            ? path.join(outputRoot, `${routeNormalized}.md`)
            : path.join(outputRoot, 'index.md');

          const overridePath = resolveOverride(routeNormalized || 'index');
          const body = overridePath
            ? fs.readFileSync(overridePath, 'utf-8').trim()
            : stripFrontmatter(fs.readFileSync(entry.filePath, 'utf-8'));

          if (!body) continue;
          if (overridePath) overridden++;

          const transformed = await processMarkdownBody(body, pipeline);
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, `${transformed}\n`);
          written++;
        }

        logger.info(`Wrote ${written} markdown pages to dist/ (${overridden} from overrides).`);
      },
    },
  };
}
