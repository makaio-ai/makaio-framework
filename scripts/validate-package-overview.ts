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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackageOverview, parseYarnWorkspacesList } from './lib/package-overview-invariants.js';

const frameworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageOverviewPath = join(frameworkRoot, 'docs', 'package-overview.md');
const workspaceOutput = execFileSync('yarn', ['workspaces', 'list', '--json'], {
  cwd: frameworkRoot,
  encoding: 'utf8',
});

const result = checkPackageOverview({
  markdown: readFileSync(packageOverviewPath, 'utf8'),
  workspaces: parseYarnWorkspacesList(workspaceOutput),
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
