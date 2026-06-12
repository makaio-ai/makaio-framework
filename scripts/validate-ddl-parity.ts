#!/usr/bin/env tsx
/**
 * CLI entry point for the generated-DDL parity lint (net 5).
 *
 * Compares the committed SQLite migration chain
 * (`storage/migrations/drizzle`) against the committed Postgres chain
 * (`storage/pg/drizzle-postgres`, resolved through the Postgres engine package)
 * at table, column, and index granularity, with 63-byte identifier
 * normalization. Catches divergence that survives the type-image parity test
 * (net 2) and the generation-time schema strictness (net 4): a table or column
 * present in one chain only, a forgotten index or unique-constraint twin, and
 * hand-written SQL without a paired counterpart or n/a marker.
 *
 * When the Postgres engine package is absent (a baseline-only checkout), there
 * is no Postgres chain to compare against, so the lint prints a skip notice and
 * exits 0. Otherwise it exits 1 on any finding.
 * @example
 * ```bash
 * bun scripts/validate-ddl-parity.ts
 * ```
 * @packageDocumentation
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findDdlParityFindings } from './lib/ddl-parity-validator.js';

const require = createRequire(import.meta.url);
const frameworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sqliteChainDir = join(frameworkRoot, 'storage', 'migrations', 'drizzle');

/** Postgres engine package whose presence gates the comparison. */
const POSTGRES_ENGINE_PACKAGE = '@makaio/storage-pg';
/** Directory holding the Postgres chain, relative to the engine package root. */
const POSTGRES_CHAIN_DIR_NAME = 'drizzle-postgres';

/**
 * Resolve the committed Postgres chain dir via the engine package, or
 * `undefined` when the engine package is not installed.
 * @returns Absolute Postgres chain dir, or `undefined` if the engine is absent.
 */
function resolvePostgresChainDir(): string | undefined {
  try {
    const engineRoot = dirname(require.resolve(`${POSTGRES_ENGINE_PACKAGE}/package.json`));
    return join(engineRoot, POSTGRES_CHAIN_DIR_NAME);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      return undefined;
    }
    throw error;
  }
}

const postgresChainDir = resolvePostgresChainDir();

if (postgresChainDir === undefined) {
  console.info('ddl-parity: postgres engine absent, skipping');
  process.exit(0);
}

const findings = findDdlParityFindings({ sqliteChainDir, postgresChainDir });

if (findings.length === 0) {
  console.info('ddl-parity: clean');
  process.exit(0);
}

console.error(`ddl-parity: ${findings.length} discrepanc${findings.length === 1 ? 'y' : 'ies'} between the chains:`);
for (const finding of findings) {
  console.error(`  [${finding.kind}] missing on ${finding.chain}: ${finding.detail}`);
}
console.error(
  'Every table, column, and index in one chain must appear in the other. Hand-written SQL needs a same-stem ' +
    "counterpart in the other chain or a committed '.na.md' marker documenting why none exists.",
);
process.exit(1);
