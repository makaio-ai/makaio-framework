/**
 * Post-generation normalizer for the Postgres migration chain.
 *
 * drizzle-kit qualifies foreign-key references with the configured schema
 * (`REFERENCES "public"."sessions"(...)`). The framework requires fully
 * unqualified DDL: migrations must land in whichever schema leads the
 * connection's `search_path`, because consumers choose their own schema and
 * the storage conformance harness provisions one isolated schema per suite.
 * A single `"public".`-qualified statement silently breaks that model the
 * first time the chain is applied outside the `public` schema.
 *
 * This script strips every `"public".` qualifier from the generated SQL files
 * so the invariant holds mechanically on each `db:generate` run. It runs as
 * the final step of `db:generate` / `db:generate:fresh` and is idempotent.
 * The invariant itself is pinned by the `postgres-chain-ddl` test of
 * `@makaio/storage-migrations`, which reads this chain through the engine seam.
 *
 * NOTE: rewriting a landed migration file changes its content hash, which is
 * the ledger identity used by `applyMigrations`. Databases provisioned from
 * the pre-rewrite chain must be re-created.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Schema qualifier emitted by drizzle-kit that must never reach the chain. */
const PUBLIC_QUALIFIER = '"public".';

const migrationsDir = path.resolve(import.meta.dirname, '../drizzle-postgres');

if (!fs.existsSync(migrationsDir)) {
  console.info('[storage-pg] No drizzle-postgres directory found — nothing to normalize.');
} else {
  const sqlFiles = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  let rewritten = 0;
  for (const name of sqlFiles) {
    const filePath = path.join(migrationsDir, name);
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes(PUBLIC_QUALIFIER)) {
      continue;
    }
    fs.writeFileSync(filePath, content.replaceAll(PUBLIC_QUALIFIER, ''));
    rewritten++;
    console.info(`[storage-pg] Stripped ${PUBLIC_QUALIFIER} qualifiers from ${name}`);
  }

  if (rewritten === 0) {
    console.info(`[storage-pg] Postgres chain is fully unqualified (${sqlFiles.length} file(s) checked).`);
  }
}
