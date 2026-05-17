#!/usr/bin/env tsx
/**
 * CLI entry point for the build surface invariant checker.
 *
 * Exits with code 0 on success, 1 when invariant violations are found.
 * @example
 * ```bash
 * tsx scripts/validate-build-surface.ts
 * ```
 * @packageDocumentation
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBuildSurface } from './lib/build-surface-invariants.js';

const frameworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const result = checkBuildSurface(frameworkRoot);

if (result.ok) {
  console.info('build-surface: ok');
  process.exit(0);
}

console.error('build-surface invariant violations:');
for (const issue of result.issues) {
  console.error(`  [${issue.kind}] ${issue.message}`);
}
process.exit(1);
