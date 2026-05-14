#!/usr/bin/env tsx
/**
 * Changeset required check — verifies that a changeset file exists when
 * publishable packages are modified.
 *
 * Compares git diff between `--base` and `--head` SHAs, maps changed files
 * to publishable packages via convention-based directory matching, and
 * checks whether any `.changeset/*.md` file was added or modified.
 *
 * Exits 0 (pass) when:
 * - No publishable packages are affected by the diff.
 * - A changeset file is present in the diff.
 *
 * Exits 1 (fail) when publishable packages are affected but no changeset
 * file is found.
 * @example
 * ```bash
 * tsx scripts/changeset-required.ts --base origin/develop --head HEAD
 * ```
 */

import { execFileSync } from 'node:child_process';
import { resolveFrameworkPrefix } from './lib/changeset-bot/resolve-framework-prefix.js';
import { mapFilesToPackages } from './lib/changeset-bot/map-files-to-packages.js';

/** Parsed base/head ref pair from CLI arguments. */
interface RefRange {
  readonly base: string;
  readonly head: string;
}

/**
 * Parses CLI arguments.
 * @param argv - Process arguments (after stripping node + script path).
 * @returns Parsed base and head refs.
 */
function parseArgs(argv: string[]): RefRange {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags.set(argv[i].slice(2), argv[i + 1]);
      i++;
    }
  }

  const base = flags.get('base');
  const head = flags.get('head');
  if (!base || !head) {
    throw new Error('Usage: changeset-required --base <ref> --head <ref>');
  }
  return { base, head };
}

/**
 * Gets the list of changed files between two refs.
 * @param base - Base ref.
 * @param head - Head ref.
 * @returns Array of changed file paths (repo-root-relative).
 */
function getChangedFiles(base: string, head: string): string[] {
  const output = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf-8' });
  return output
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
}

/**
 * Tests whether a diff includes a root-level changeset file.
 * @param changedFiles - Changed file paths relative to the repository root.
 * @returns `true` when a `.changeset/*.md` file is present.
 */
export function hasChangesetFile(changedFiles: readonly string[]): boolean {
  return changedFiles.some((f) => /^\.changeset\/[^/]+\.md$/u.test(f));
}

/**
 * Runs the changeset-required check.
 * @param argv - Process arguments (after stripping node + script path).
 */
function main(argv: string[]): void {
  const { base, head } = parseArgs(argv);
  const changedFiles = getChangedFiles(base, head);

  if (changedFiles.length === 0) {
    console.info('No files changed — changeset not required.');
    process.exit(0);
  }

  const prefix = resolveFrameworkPrefix(import.meta.dirname);

  const frameworkFiles = prefix
    ? changedFiles.filter((f) => f.startsWith(prefix + '/')).map((f) => f.slice(prefix.length + 1))
    : changedFiles;

  const affectedPackages = mapFilesToPackages(frameworkFiles);

  if (affectedPackages.length === 0) {
    console.info('No publishable packages affected — changeset not required.');
    process.exit(0);
  }

  if (hasChangesetFile(changedFiles)) {
    console.info(`Changeset found for affected packages: ${affectedPackages.join(', ')}`);
    process.exit(0);
  }

  console.error(`Changeset required but not found.`);
  console.error(`Affected packages: ${affectedPackages.join(', ')}`);
  console.error(`Use /changeset on the PR to generate one, or add the 'skip-changeset' label to bypass.`);
  process.exit(1);
}

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2));
}
