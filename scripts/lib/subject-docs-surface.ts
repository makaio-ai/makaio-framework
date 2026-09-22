/**
 * Single source of truth for the committed bus subject documentation surface.
 *
 * The Markdown pages under `docs/subjects/` are generated from the bus namespace
 * analysis. The generator entry points (`scripts/analyze-bus-namespaces.ts` and
 * `scripts/generate-bus-docs.ts`) and the freshness checker
 * (`scripts/validate-subject-docs.ts`) all consume the extraction options and Markdown
 * rendering configuration exported here (the former via
 * `subject-docs-analysis-config.ts`, re-exported below) so that checked output can
 * never be produced with a different configuration than committed output.
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { listMarkdownPages, toMarkdownOptions, type GenerateDocsCliConfig } from './namespace-analyzer/cli.js';
import { extractNamespaces } from './namespace-analyzer/extract-namespaces.js';
import { generateMarkdown } from './namespace-analyzer/generate-markdown.js';
import { createAnalysisProgram } from './namespace-analyzer/program.js';
import type { AnalysisResult } from './namespace-analyzer/types.js';
import { SUBJECT_DOCS_ANALYSIS_OPTIONS, SUBJECT_DOCS_ANALYSIS_ROOT } from './subject-docs-analysis-config.js';

export { SUBJECT_DOCS_ANALYSIS_OPTIONS, SUBJECT_DOCS_ANALYSIS_ROOT };

/** Committed documentation directory, relative to the analysis root. */
export const SUBJECT_DOCS_DIR_RELATIVE = 'docs/subjects';

/** Absolute path to the committed documentation directory. */
export const SUBJECT_DOCS_DIR = resolve(SUBJECT_DOCS_ANALYSIS_ROOT, SUBJECT_DOCS_DIR_RELATIVE);

/** Rendering configuration of the committed subject documentation surface. */
export const SUBJECT_DOCS_CONFIG: GenerateDocsCliConfig = {
  title: 'Bus Subject Namespaces (Framework)',
  sourceRoot: '',
  includeTiers: ['framework', 'extension'],
  includeHostCallsites: false,
  sourceBaseUrl: 'https://github.com/makaio-ai/makaio-framework/blob/{branch}',
  frontmatter: true,
  indexFileName: 'index.md',
};

// The freshness gate renders this surface in memory without ever computing a source
// commit (see `UNUSED_SOURCE_COMMIT` below). A `{commit}` placeholder here would only
// ever resolve for the one-off run that regenerated the committed pages, making this
// checked-in surface impossible to reproduce from any later commit.
if (SUBJECT_DOCS_CONFIG.sourceBaseUrl?.includes('{commit}')) {
  throw new Error(
    'SUBJECT_DOCS_CONFIG.sourceBaseUrl must not reference {commit}: this surface must be ' +
      'reproducible from any commit, and the freshness gate never computes one to substitute.',
  );
}

/**
 * Placeholder written into the in-memory analysis result the freshness gate renders.
 *
 * {@link SUBJECT_DOCS_CONFIG}'s `sourceBaseUrl` only substitutes `{branch}`, never
 * `{commit}` (enforced above), so this value is never read from rendered output.
 * Computing a real commit here would only make the gate fail in environments without
 * git for a value nobody consumes.
 */
const UNUSED_SOURCE_COMMIT = 'unused';

/** A rendered documentation page and its location inside the documentation directory. */
export interface GeneratedSubjectDoc {
  /** Page path relative to the documentation directory, e.g. `kernel.md`. */
  readonly path: string;
  /** Fully rendered page content. */
  readonly content: string;
}

/** Committed pages that no longer match the pages the analysis renders. */
export interface SubjectDocDrift {
  /** Pages that are missing or whose committed content differs from the rendered content. */
  readonly stale: readonly string[];
  /** Committed pages that the analysis no longer renders at all. */
  readonly orphaned: readonly string[];
}

/**
 * Renders the committed subject documentation surface in memory.
 *
 * Callsite scanning is intentionally skipped: the committed pages do not render
 * callsites, and scanning them would only slow the analysis down.
 * @param branch - Branch the generated source links should point at. Defaults to `develop`
 * (the {@link toMarkdownOptions} fallback), the same default `generate-bus-docs.ts` uses.
 * @returns Rendered pages with paths relative to the documentation directory.
 */
export function generateSubjectDocs(branch?: string): GeneratedSubjectDoc[] {
  const program = createAnalysisProgram(SUBJECT_DOCS_ANALYSIS_ROOT);
  const namespaces = extractNamespaces(program, SUBJECT_DOCS_ANALYSIS_ROOT, SUBJECT_DOCS_ANALYSIS_OPTIONS);

  const analysis: AnalysisResult = {
    analyzedAt: new Date().toISOString(),
    sourceCommit: UNUSED_SOURCE_COMMIT,
    namespaces: namespaces.sort((a, b) => a.prefix.localeCompare(b.prefix)),
  };

  const options = toMarkdownOptions(SUBJECT_DOCS_CONFIG, {
    docsRoot: SUBJECT_DOCS_DIR_RELATIVE,
    sourceCommit: analysis.sourceCommit,
    branch: branch ?? null,
  });

  return generateMarkdown(analysis, options);
}

/**
 * Compares rendered pages against the committed documentation directory.
 * @param files - Rendered pages with paths relative to the documentation directory.
 * @param docsDir - Absolute documentation directory to compare against.
 * @returns Stale and orphaned page paths relative to `docsDir`. Callers that print these
 * paths own prefixing them with whatever root they invoked the gate from — see
 * {@link formatSubjectDocDriftMessage}.
 */
export function findSubjectDocDrift(
  files: readonly GeneratedSubjectDoc[],
  docsDir: string = SUBJECT_DOCS_DIR,
): SubjectDocDrift {
  const stale: string[] = [];
  const generatedPaths = new Set<string>();

  for (const file of files) {
    generatedPaths.add(file.path);
    let committed: string;
    try {
      committed = readFileSync(join(docsDir, file.path), 'utf-8');
    } catch {
      stale.push(file.path);
      continue;
    }
    if (committed !== file.content) {
      stale.push(file.path);
    }
  }

  const orphaned = listCommittedPages(docsDir).filter((page) => !generatedPaths.has(page));

  return { stale: stale.sort(), orphaned: orphaned.sort() };
}

/**
 * Lists committed Markdown pages below the documentation directory, tolerating an absent
 * directory.
 *
 * A PR that deletes every tracked page under `docs/subjects/` removes the directory itself
 * along with its contents, and the page loop above already reports every generated page as
 * stale in that case. Without this, {@link listMarkdownPages}'s unconditional `readdirSync`
 * would throw `ENOENT` and replace the drift report with a stack trace. Any other I/O error
 * (e.g. `docsDir` resolving to a file) still propagates, since it signals something the
 * freshness gate cannot reason about.
 * @param docsDir - Documentation directory to scan, absolute or relative to the current
 * working directory.
 * @returns Page paths relative to `docsDir`, or an empty array if `docsDir` does not exist.
 */
function listCommittedPages(docsDir: string): string[] {
  try {
    return listMarkdownPages(docsDir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Formats a drift report that names the regeneration command and every affected page.
 * @param drift - Drift detected against the committed documentation directory, with paths
 * relative to the documentation directory (see {@link findSubjectDocDrift}).
 * @param fixCommand - Command that regenerates the committed pages.
 * @param reportRoot - Documentation directory path to prefix each reported page with, relative
 * to the root the gate was invoked from (e.g. `docs/subjects` from the framework
 * distribution root, or a host-supplied path when invoked from a different root).
 * @returns Human-readable multi-line drift report.
 */
export function formatSubjectDocDriftMessage(drift: SubjectDocDrift, fixCommand: string, reportRoot: string): string {
  const lines = [`Bus subject docs are stale. Run \`${fixCommand}\` and commit the regenerated pages:`];

  for (const page of drift.stale) {
    lines.push(`- outdated: ${reportRoot}/${page}`);
  }
  for (const page of drift.orphaned) {
    lines.push(`- no longer generated: ${reportRoot}/${page}`);
  }

  return lines.join('\n');
}
