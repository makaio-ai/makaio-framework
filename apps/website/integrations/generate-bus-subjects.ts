import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AstroIntegration } from 'astro';
import { extractNamespaces } from '../../../scripts/lib/namespace-analyzer/extract-namespaces.js';
import {
  generateMarkdown,
  type MarkdownGenerationOptions,
} from '../../../scripts/lib/namespace-analyzer/generate-markdown.js';
import { createAnalysisProgram } from '../../../scripts/lib/namespace-analyzer/program.js';
import type { AnalysisResult } from '../../../scripts/lib/namespace-analyzer/types.js';

const FRAMEWORK_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const OUTPUT_DIR = path.resolve(import.meta.dirname, '..', 'src/content/docs/reference/subjects');
const DOCS_ROOT = 'apps/website/src/content/docs/reference/subjects';
const SOURCE_BASE_URL = 'https://github.com/makaio-ai/makaio-framework/blob';

interface GeneratedMarkdownFile {
  /** Relative Markdown path emitted by the bus docs generator. */
  path: string;
  /** Complete Markdown body without Starlight frontmatter. */
  content: string;
}

interface WriteBusSubjectPagesOptions {
  /** Starlight content directory for generated bus subject pages. */
  outputDir: string;
  /** Git revision that the generated docs were analyzed from. */
  sourceCommit: string;
  /** Markdown files emitted by the namespace analyzer documentation renderer. */
  files: readonly GeneratedMarkdownFile[];
}

/**
 * Writes generated bus subject Markdown into Starlight's content tree.
 * @param options - Generated files and destination directory.
 */
export function writeBusSubjectPages(options: WriteBusSubjectPagesOptions): void {
  fs.rmSync(options.outputDir, { recursive: true, force: true });
  fs.mkdirSync(options.outputDir, { recursive: true });

  for (const file of options.files) {
    const outputPath = path.join(options.outputDir, starlightPath(file.path));
    const relativeOutputPath = path.relative(options.outputDir, outputPath);
    if (relativeOutputPath.startsWith('..') || path.isAbsolute(relativeOutputPath)) {
      throw new Error(`Generated bus subject path escapes output directory: ${file.path}`);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const content = normalizeSourceLinks(normalizeStarlightLinks(file.content), options.sourceCommit);
    fs.writeFileSync(outputPath, frontmatterFor(file.path, content) + content);
  }
}

/**
 * Resolves the current source commit when Git metadata is available.
 * @param frameworkRoot - Framework checkout root.
 * @returns Git commit SHA, or `unknown` when the build runs from an archive.
 */
export function resolveSourceCommit(frameworkRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: frameworkRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Creates an Astro integration that generates bus subject reference pages before Starlight loads content.
 * @returns Astro integration for generated bus subject reference pages.
 */
export function generateBusSubjects(): AstroIntegration {
  return {
    name: 'generate-bus-subjects',
    hooks: {
      'astro:config:setup': () => {
        const program = createAnalysisProgram(FRAMEWORK_ROOT);
        const namespaces = extractNamespaces(program, FRAMEWORK_ROOT);
        const analysis: AnalysisResult = {
          analyzedAt: new Date().toISOString(),
          sourceCommit: resolveSourceCommit(FRAMEWORK_ROOT),
          namespaces: namespaces.sort((a, b) => a.prefix.localeCompare(b.prefix)),
        };
        const markdownOptions: MarkdownGenerationOptions = {
          title: 'Bus Subject Namespaces (Framework)',
          docsRoot: DOCS_ROOT,
          sourceRoot: '',
          includeTiers: ['framework', 'extension'],
          includeProductCallsites: false,
        };

        writeBusSubjectPages({
          outputDir: OUTPUT_DIR,
          sourceCommit: analysis.sourceCommit,
          files: generateMarkdown(analysis, markdownOptions),
        });
      },
    },
  };
}

/**
 * Converts generator README paths to Starlight index pages.
 * @param filePath - Relative Markdown path emitted by the generator.
 * @returns Relative path for Starlight content.
 */
function starlightPath(filePath: string): string {
  return filePath.replace(/(^|\/)README\.md$/, '$1index.md');
}

/**
 * Rewrites generator index-file links to their Starlight directory routes.
 * @param content - Markdown body emitted by the generator.
 * @returns Markdown body with Starlight-compatible index links.
 */
function normalizeStarlightLinks(content: string): string {
  return content.replaceAll(/(\]\(\.\/(?:[^)\s]+\/)*)README\.md\)/g, '$1)');
}

/**
 * Rewrites generated repository-relative source links to GitHub URLs.
 * @param content - Markdown body emitted by the generator.
 * @param sourceCommit - Git revision used for the namespace analysis.
 * @returns Markdown body with source links pointing at the framework repository.
 */
function normalizeSourceLinks(content: string, sourceCommit: string): string {
  return content.replaceAll(/\]\(((?:\.\.\/)+)([^)#\s]+)(#[^)\s]+)?\)/g, (_match, _prefix, sourcePath, hash = '') => {
    return `](${SOURCE_BASE_URL}/${sourceCommit}/${String(sourcePath)}${String(hash)})`;
  });
}

/**
 * Builds Starlight frontmatter for a generated bus subject page.
 * @param filePath - Relative Markdown path emitted by the generator.
 * @param content - Markdown body emitted by the generator.
 * @returns Frontmatter text to prepend to the page.
 */
function frontmatterFor(filePath: string, content: string): string {
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.replace(/[`*]/g, '') ?? path.basename(filePath, '.md');

  return `---\ntitle: ${JSON.stringify(title)}\neditUrl: false\nprev: false\nnext: false\n---\n\n`;
}
