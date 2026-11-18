/**
 * Bun lane for the SQLite handle re-entrancy suite.
 *
 * The suite itself is runner-agnostic: Bun's test runner resolves its `vitest`
 * imports to `bun:test`, so this lane registers the very same cases against
 * the `bun:sqlite` driver.
 */
import './handle-reentrancy.test';
