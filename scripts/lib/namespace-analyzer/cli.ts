import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /** Whether product callsites should be rendered. */
  includeProductCallsites: boolean;
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
  const markdownOptions: MarkdownGenerationOptions = {
    title: config.title,
    docsRoot: opts.out,
    sourceRoot: config.sourceRoot,
    includeTiers: config.includeTiers,
    includeProductCallsites: config.includeProductCallsites,
  };
  const files = generateMarkdown(analysis, markdownOptions);

  mkdirSync(opts.out, { recursive: true });

  for (const file of files) {
    const fullPath = join(opts.out, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, 'utf-8');
  }

  console.error(`Wrote ${String(files.length)} files to ${opts.out}`);
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
    throw new Error(`Invalid analysis JSON: ${message}`);
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
  const callsites = candidate.callsites as { framework?: unknown; product?: unknown } | undefined;

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
    Array.isArray(callsites.product)
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
    },
    strict: true,
  });

  if (!values.out) {
    console.error('Usage: generate-bus-docs --out <dir> [--input <json>]');
    process.exit(2);
  }

  return {
    input: values.input ?? null,
    out: values.out,
  };
}

/**
 * Prints a tier-breakdown and per-namespace summary table to stderr.
 * @param namespaces - The fully-populated namespace entries to summarize.
 */
function printSummary(namespaces: NamespaceEntry[]): void {
  const tiers = { framework: 0, product: 0, 'product-web': 0, extension: 0 };
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
  console.error(`  product:     ${tiers.product}`);
  console.error(`  product-web: ${tiers['product-web']}`);
  console.error(`  extension:   ${tiers.extension}`);
  console.error(`Subjects: ${totalSubjects} (${events} events, ${rpcs} RPCs)`);

  console.error('\n--- Per Namespace ---');
  for (const ns of namespaces) {
    const callsiteCount = ns.callsites.framework.length + ns.callsites.product.length;
    console.error(
      `  ${ns.prefix.padEnd(30)} ${ns.tier.padEnd(12)} ${String(ns.subjects.length).padStart(3)} subjects  ${String(callsiteCount).padStart(3)} callsites  ${ns.definedIn.package ?? ns.definedIn.file}`,
    );
  }
}
