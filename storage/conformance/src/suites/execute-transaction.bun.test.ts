/**
 * Bun lane for the executeTransaction conformance suite.
 *
 * Under Bun, local databases run on the `bun:sqlite` driver instead of
 * `@libsql/client`, so the transaction contract (atomicity, rollback,
 * serialization) must be proven on that driver too. The suite itself is
 * runner-agnostic: Bun's test runner resolves its `vitest` imports to
 * `bun:test`, so this lane registers the very same cases instead of
 * duplicating them.
 */
import './execute-transaction.test.js';
