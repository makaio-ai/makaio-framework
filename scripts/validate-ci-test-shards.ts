#!/usr/bin/env tsx
/**
 * Validates that every Vitest project in the framework config is covered
 * by a CI shard, and that no workflow shard is stale.
 *
 * Exits 0 when coverage is complete, 1 when issues are found.
 * @example
 * ```bash
 * bun scripts/validate-ci-test-shards.ts
 * ```
 * @packageDocumentation
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frameworkShards, FRAMEWORK_SPECIAL_PROJECT_NAMES } from './lib/vitest-categories.js';
import { checkShardCoverage, extractShardsFromWorkflowYaml } from './lib/ci-shard-coverage.js';

const frameworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const ciWorkflowPath = join(frameworkRoot, '.github', 'workflows', 'ci.yml');
const ciWorkflowYaml = readFileSync(ciWorkflowPath, 'utf8');
const claimedShards = extractShardsFromWorkflowYaml(ciWorkflowYaml);

const projectNames: string[] = [...Object.keys(frameworkShards), ...FRAMEWORK_SPECIAL_PROJECT_NAMES];

/**
 * Projects intentionally excluded from the CI shard matrix.
 * Each entry must be justified below.
 */
const intentionallyUnclaimed: readonly string[] = [
  // git-serial: Uses a dedicated serial forks pool to avoid cross-file git
  // process contention. Not yet wired into the CI shard matrix — these tests
  // do not run in CI at the time of writing. Add to .github/workflows/ci.yml
  // test_shards when the team decides CI coverage is required.
  'git-serial',
];

const issues = checkShardCoverage({ projectNames, claimedShards, intentionallyUnclaimed });

if (issues.length === 0) {
  console.info('ci-shard-coverage (framework): all projects are covered');
  process.exit(0);
}

console.error('ci-shard-coverage (framework): coverage violations found:');
for (const issue of issues) {
  console.error(`  ${issue}`);
}
process.exit(1);
