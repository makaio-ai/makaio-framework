#!/usr/bin/env tsx
/**
 * CLI entry point for the package overview drift checker.
 *
 * Exits with code 0 when `docs/package-overview.md` matches the Yarn workspace inventory.
 * @example
 * ```bash
 * tsx scripts/validate-package-overview.ts
 * ```
 * @packageDocumentation
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPackageOverview,
  filterDeclaredWorkspaces,
  parseYarnWorkspacesList,
  scopeWorkspacesToRoot,
} from './lib/package-overview-invariants.js';

/**
 * Locate the active Yarn project containing a logical package root.
 * @param startDir - Logical package root to search from.
 * @returns Nearest ancestor containing a Yarn lockfile.
 */
function findYarnProjectRoot(startDir: string): string {
  let current = startDir;
  while (true) {
    if (existsSync(join(current, 'yarn.lock'))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find a Yarn project containing ${startDir}`);
    }
    current = parent;
  }
}

const frameworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const frameworkManifestPath = join(frameworkRoot, 'package.json');
const packageOverviewPath = join(frameworkRoot, 'docs', 'package-overview.md');
const yarnProjectRoot = findYarnProjectRoot(frameworkRoot);
const frameworkLocation = relative(yarnProjectRoot, frameworkRoot).split(sep).join('/') || '.';
const workspaceOutput = execFileSync('yarn', ['workspaces', 'list', '--json'], {
  cwd: yarnProjectRoot,
  encoding: 'utf8',
});
const frameworkManifest = JSON.parse(readFileSync(frameworkManifestPath, 'utf8')) as { workspaces?: unknown };
if (
  !Array.isArray(frameworkManifest.workspaces) ||
  !frameworkManifest.workspaces.every((pattern): pattern is string => typeof pattern === 'string')
) {
  throw new Error(`${frameworkManifestPath} must declare a string-array workspaces field`);
}
const scopedWorkspaces = scopeWorkspacesToRoot(parseYarnWorkspacesList(workspaceOutput), frameworkLocation);

const result = checkPackageOverview({
  markdown: readFileSync(packageOverviewPath, 'utf8'),
  workspaces: filterDeclaredWorkspaces(scopedWorkspaces, frameworkManifest.workspaces),
});

if (result.ok) {
  console.info('package-overview: ok');
  process.exit(0);
}

console.error('package-overview invariant violations:');
for (const issue of result.issues) {
  console.error(`  [${issue.kind}] ${issue.message}`);
}
process.exit(1);
