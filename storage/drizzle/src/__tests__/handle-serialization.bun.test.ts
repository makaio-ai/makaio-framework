/**
 * Bun lane for the SQLite handle serialization suite.
 *
 * Under Bun, local databases run on the `bun:sqlite` driver instead of
 * `@libsql/client`, so the handle contract must be proven on that driver too.
 * The suite itself is runner-agnostic: Bun's test runner resolves its `vitest`
 * imports to `bun:test`, so this lane registers the very same cases.
 */
import './handle-serialization.test';
