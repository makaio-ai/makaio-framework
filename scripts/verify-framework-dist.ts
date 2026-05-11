#!/usr/bin/env tsx
/**
 * CLI entry point for framework dist export verification.
 *
 * Exits with code 0 on success, 1 when built export targets are missing.
 * @example
 * ```bash
 * tsx framework/scripts/verify-framework-dist.ts
 * ```
 * @packageDocumentation
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFrameworkDist } from './lib/framework-dist-verifier.js';

const frameworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = verifyFrameworkDist(frameworkRoot);

if (result.ok) {
  console.info(`framework-dist: ok (${result.checkedTargets} export targets)`);
  process.exit(0);
}

console.error('framework-dist verification failed:');
for (const issue of result.issues) {
  console.error(`  [${issue.kind}] ${issue.message}`);
}
process.exit(1);
