#!/usr/bin/env tsx
/**
 * CLI entry point for the raw-SQL call-site validator.
 *
 * Fails when production code calls the raw SQLite driver surface
 * (`db.run/all/get/values`) or a query-builder execution terminal
 * (`.run()` / `.all()` / `.get()` / `.values()`) instead of the
 * dialect-portable executor (`getRawSqlExecutor` from
 * `@makaio/storage-drizzle`).
 *
 * Exits with code 0 on success, 1 when violations are found.
 * @example
 * ```bash
 * bun scripts/validate-raw-sql.ts
 * ```
 * @packageDocumentation
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAW_SQL_SUPPRESSION_TOKEN, scanForRawSqlViolations } from './lib/raw-sql-validator.js';

const frameworkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const violations = scanForRawSqlViolations(frameworkRoot);

if (violations.length === 0) {
  console.info('raw-sql: clean');
  process.exit(0);
}

console.error(`raw-sql: ${violations.length} call site(s) bypass the RawSqlExecutor seam:`);
for (const violation of violations) {
  console.error(`  ${violation.file}:${violation.line} [${violation.kind}] ${violation.snippet}`);
}
console.error(
  'Use getRawSqlExecutor(db).run/all (raw statements) or await the query builder directly (terminals). ' +
    `Reviewed exceptions: add a '${RAW_SQL_SUPPRESSION_TOKEN}' comment on the line or the line above.`,
);
process.exit(1);
