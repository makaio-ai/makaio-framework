/**
 * Bun lane for the host transaction facade conformance suite.
 *
 * Under Bun, local databases run on the `bun:sqlite` driver instead of
 * `@libsql/client`, so the guarantee that every builder and prepared query of
 * a host transaction runs in exactly that transaction must be proven on that
 * driver too. The suite itself is runner-agnostic: Bun's test runner resolves
 * its `vitest` imports to `bun:test`, so this lane registers the very same
 * cases instead of duplicating them.
 */
import './host-database.test.js';
