/**
 * Bun lane for the database wake conformance suite.
 *
 * Under Bun, local databases run on the `bun:sqlite` driver instead of
 * `@libsql/client`, so the wake seam's local-delivery and capability-
 * declaration guarantees (including the `in-memory` capability, which only
 * `bun:sqlite` ever produces) must be proven on that driver too. The suite
 * itself is runner-agnostic: Bun's test runner resolves its `vitest` imports
 * to `bun:test`, so this lane registers the very same cases instead of
 * duplicating them.
 */
import './database-wake.test.js';
