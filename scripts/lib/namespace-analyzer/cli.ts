import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { extractNamespaces, type NamespaceExtractionOptions } from './extract-namespaces.js';
import { findCallsites, type CallsiteScanOptions } from './find-callsites.js';
import { generateMarkdown, type MarkdownGenerationOptions } from './generate-markdown.js';
import { createAnalysisProgram } from './program.js';
import type { AnalysisResult, NamespaceEntry } from './types.js';

export interface AnalyzeNamespacesCliConfig {
  /** Absolute root whose tsconfig and relative paths define the analysis boundary. */
  root: string;
  /** Optional path prefixes to skip during namespace extraction. */
  namespaceExcludePathPrefixes?: readonly string[];
  /** Optional named field types to expand in subject field docs for this docs surface. */
  subjectFieldTypeExpansions?: readonly string[];
  /** Host policy that classifies namespace definition paths for documentation tiers. */
  classifyNamespaceTier?: NamespaceExtractionOptions['classifyNamespaceTier'];
  /** Optional path prefixes to skip during callsite scanning. */
  callsiteExcludePathPrefixes?: readonly string[];
  /** Host policy that classifies callsite paths for documentation buckets. */
  classifyCallsiteTier?: CallsiteScanOptions['classifyCallsiteTier'];
}

export interface GenerateDocsCliConfig {
  /** Root README title. */
  title: string;
  /** Source path root relative to the same root as the generated docs directory. */
  sourceRoot: string;
  /** Optional namespace tiers to include. Omit to include all namespaces in the analysis. */
  includeTiers?: readonly NamespaceEntry['tier'][];
  /** Whether host callsites should be rendered. */
  includeHostCallsites: boolean;
  /**
   * When set, source-file links become absolute URLs under this base
   * (e.g. `https://github.com/org/repo/blob/<commit>`).
   * The placeholder `{commit}` is replaced with the analysis' `sourceCommit`.
   */
  sourceBaseUrl?: string;
  /** When true, each file is prepended with Starlight-compatible YAML frontmatter. */
  frontmatter?: boolean;
  /** File name for directory index pages. Defaults to `'README.md'`. */
  indexFileName?: string;
}

/**
 * Runs the namespace analysis CLI for a concrete analysis root.
 * @param config - Entrypoint-specific root and filter configuration.
 */
export function runAnalyzeNamespacesCli(config: AnalyzeNamespacesCliConfig): void {
  const opts = parseAnalyzeCli();

  console.error('Loading TypeScript program...');
  const program = createAnalysisProgram(config.root);
  console.error(`Program loaded: ${program.getSourceFiles().length} source files`);

  const namespaceOptions: NamespaceExtractionOptions = {
    excludePathPrefixes: config.namespaceExcludePathPrefixes,
    subjectFieldTypeExpansions: config.subjectFieldTypeExpansions,
    classifyNamespaceTier: config.classifyNamespaceTier,
  };
  const callsiteOptions: CallsiteScanOptions = {
    excludePathPrefixes: config.callsiteExcludePathPrefixes,
    classifyCallsiteTier: config.classifyCallsiteTier,
  };

  console.error('\nExtracting namespace registrations...');
  const namespaces = extractNamespaces(program, config.root, namespaceOptions);

  if (!opts.noCallsites) {
    console.error('\nScanning for callsites...');
    findCallsites(program, namespaces, config.root, callsiteOptions);
  }

  // The generated inventory must be tied to an exact repository revision;
  // failing without git is preferable to emitting unverifiable provenance.
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: config.root,
    encoding: 'utf-8',
  }).trim();

  const result: AnalysisResult = {
    analyzedAt: new Date().toISOString(),
    sourceCommit,
    namespaces: namespaces.sort((a, b) => a.prefix.localeCompare(b.prefix)),
  };

  if (opts.summary) {
    printSummary(namespaces);
  }

  const json = JSON.stringify(result, null, 2) + '\n';

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, json, 'utf-8');
    console.error(`\nWrote ${namespaces.length} namespaces to ${opts.out}`);
  } else {
    process.stdout.write(json);
  }
}

/**
 * Runs the Markdown generation CLI for a concrete docs surface.
 * @param config - Entrypoint-specific Markdown rendering configuration.
 */
export function runGenerateDocsCli(config: GenerateDocsCliConfig): void {
  const opts = parseGenerateCli();
  const raw = opts.input ? readFileSync(opts.input, 'utf-8') : readFileSync(0, 'utf-8');
  let analysis: AnalysisResult;
  try {
    analysis = parseAnalysisResult(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(2);
  }
  const files = generateMarkdown(
    analysis,
    toMarkdownOptions(config, {
      docsRoot: opts.out,
      sourceCommit: analysis.sourceCommit,
      branch: opts.branch,
    }),
  );

  mkdirSync(opts.out, { recursive: true });

  const generatedPaths = new Set<string>();
  for (const file of files) {
    generatedPaths.add(file.path);
    const fullPath = join(opts.out, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, 'utf-8');
  }

  // Pages that used to be generated (e.g. a namespace was removed or renamed) are
  // never written above, so they would otherwise linger and keep the freshness
  // gate red even after a regeneration. Sweep them here using the same listing the
  // gate uses to detect them.
  const orphaned = listMarkdownPages(opts.out).filter((page) => !generatedPaths.has(page));
  for (const page of orphaned) {
    const fullPath = join(opts.out, page);
    unlinkSync(fullPath);
    console.error(`Removed orphaned page ${fullPath}`);
  }

  console.error(`Wrote ${String(files.length)} files to ${opts.out}`);
}

/**
 * Lists committed Markdown pages below a documentation directory.
 *
 * The `data/` subdirectory holds gitignored analysis intermediates (JSON input to the
 * generator, not a generated page) and is skipped so a stray file there is never
 * mistaken for an orphaned page.
 * @param dir - Documentation directory to scan, relative to the current working directory
 * or absolute.
 * @returns Page paths relative to `dir`.
 */
export function listMarkdownPages(dir: string): string[] {
  const pages: string[] = [];

  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (prefix === '' && entry.name === 'data') continue;
        walk(join(directory, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (entry.name.endsWith('.md')) {
        pages.push(`${prefix}${entry.name}`);
      }
    }
  };

  walk(dir, '');

  return pages;
}

/** Concrete rendering context a docs surface is generated for. */
export interface MarkdownRenderContext {
  /** Output directory path, relative to the same root as the analyzed source paths. */
  docsRoot: string;
  /** Revision the analysis was taken at, substituted into `{commit}` source links. */
  sourceCommit: string;
  /** Branch substituted into `{branch}` source links. Defaults to `develop` when null. */
  branch: string | null;
}

/**
 * Binds a docs surface configuration to a concrete rendering context.
 * @param config - Surface-level Markdown rendering configuration.
 * @param context - Output root and source revision the surface is rendered for.
 * @returns Fully resolved Markdown generation options.
 */
export function toMarkdownOptions(
  config: GenerateDocsCliConfig,
  context: MarkdownRenderContext,
): MarkdownGenerationOptions {
  return {
    title: config.title,
    docsRoot: context.docsRoot,
    sourceRoot: config.sourceRoot,
    includeTiers: config.includeTiers,
    includeHostCallsites: config.includeHostCallsites,
    sourceBaseUrl: config.sourceBaseUrl
      ?.replace('{commit}', context.sourceCommit)
      .replace('{branch}', context.branch ?? 'develop'),
    frontmatter: config.frontmatter,
    indexFileName: config.indexFileName,
  };
}

/**
 * Parses and minimally validates analyzer JSON before Markdown generation.
 * @param raw - Raw JSON payload to parse.
 * @returns A validated analysis result payload.
 */
export function parseAnalysisResult(raw: string): AnalysisResult {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isAnalysisResultPayload(parsed)) {
      throw new Error('Input is not a valid AnalysisResult payload');
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid analysis JSON: ${message}`, { cause: error });
  }
}

/**
 * Checks the minimum shape required by the Markdown generator.
 * @param value - Parsed JSON value to inspect.
 * @returns `true` when the value has the expected analysis result shape.
 */
function isAnalysisResultPayload(value: unknown): value is AnalysisResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { analyzedAt?: unknown; sourceCommit?: unknown; namespaces?: unknown };
  return (
    typeof candidate.analyzedAt === 'string' &&
    typeof candidate.sourceCommit === 'string' &&
    Array.isArray(candidate.namespaces) &&
    candidate.namespaces.every(isNamespaceEntryPayload)
  );
}

/**
 * Checks the minimum namespace shape dereferenced by the Markdown renderer.
 * @param value - Parsed namespace entry to inspect.
 * @returns `true` when the namespace entry has the required fields.
 */
function isNamespaceEntryPayload(value: unknown): value is NamespaceEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as {
    prefix?: unknown;
    tier?: unknown;
    definedIn?: unknown;
    subjects?: unknown;
    callsites?: unknown;
  };
  const definedIn = candidate.definedIn as { file?: unknown } | undefined;
  const callsites = candidate.callsites as { framework?: unknown; host?: unknown } | undefined;

  return (
    typeof candidate.prefix === 'string' &&
    typeof candidate.tier === 'string' &&
    !!definedIn &&
    typeof definedIn === 'object' &&
    typeof definedIn.file === 'string' &&
    Array.isArray(candidate.subjects) &&
    !!callsites &&
    typeof callsites === 'object' &&
    Array.isArray(callsites.framework) &&
    Array.isArray(callsites.host)
  );
}

interface AnalyzeCliOptions {
  out: string | null;
  noCallsites: boolean;
  summary: boolean;
}

/**
 * Parses command-line arguments into structured analyzer CLI options.
 * @returns The parsed analyzer CLI options.
 */
function parseAnalyzeCli(): AnalyzeCliOptions {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', short: 'o' },
      'no-callsites': { type: 'boolean', default: false },
      summary: { type: 'boolean', short: 's', default: false },
    },
    strict: true,
  });

  return {
    out: values.out ?? null,
    noCallsites: values['no-callsites'] ?? false,
    summary: values.summary ?? false,
  };
}

interface GenerateCliOptions {
  input: string | null;
  out: string;
  branch: string | null;
}

/**
 * Parses command-line arguments into structured Markdown generation options.
 * @returns Validated Markdown generation CLI options.
 */
function parseGenerateCli(): GenerateCliOptions {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', short: 'i' },
      out: { type: 'string', short: 'o' },
      branch: { type: 'string', short: 'b' },
    },
    strict: true,
  });

  if (!values.out) {
    console.error('Usage: generate-bus-docs --out <dir> [--input <json>] [--branch <name>]');
    process.exit(2);
  }

  return {
    input: values.input ?? null,
    out: values.out,
    branch: values.branch ?? null,
  };
}

/**
 * Prints a tier-breakdown and per-namespace summary table to stderr.
 * @param namespaces - The fully-populated namespace entries to summarize.
 */
function printSummary(namespaces: NamespaceEntry[]): void {
  const tiers: Record<NamespaceEntry['tier'], number> = { framework: 0, host: 0, 'host-web': 0, extension: 0 };
  let totalSubjects = 0;
  let events = 0;
  let rpcs = 0;

  for (const ns of namespaces) {
    tiers[ns.tier]++;
    totalSubjects += ns.subjects.length;
    for (const subject of ns.subjects) {
      if (subject.type === 'event') events++;
      else rpcs++;
    }
  }

  console.error('\n--- Summary ---');
  console.error(`Namespaces: ${namespaces.length}`);
  console.error(`  framework:   ${tiers.framework}`);
  console.error(`  host:        ${tiers.host}`);
  console.error(`  host-web:    ${tiers['host-web']}`);
  console.error(`  extension:   ${tiers.extension}`);
  console.error(`Subjects: ${totalSubjects} (${events} events, ${rpcs} RPCs)`);

  console.error('\n--- Per Namespace ---');
  for (const ns of namespaces) {
    const callsiteCount = ns.callsites.framework.length + ns.callsites.host.length;
    console.error(
      `  ${ns.prefix.padEnd(30)} ${ns.tier.padEnd(12)} ${String(ns.subjects.length).padStart(3)} subjects  ${String(callsiteCount).padStart(3)} callsites  ${ns.definedIn.package ?? ns.definedIn.file}`,
    );
  }
}
