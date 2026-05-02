import { E2E_DB_PATH, E2E_PORT_FILE, SQLITE_SIDECARS, tryUnlink } from './harness/db-path.js';

/**
 * Removes the temporary e2e database, its SQLite sidecar files, and the
 * shared port file written by the Playwright coordinator.
 *
 * Note: `run-electron-e2e.ts` also cleans these files in its `finally` block.
 * The redundancy is intentional — if Playwright crashes before this teardown
 * runs, the outer wrapper still cleans up.
 */
export default function globalTeardown(): void {
  for (const suffix of ['', ...SQLITE_SIDECARS]) {
    tryUnlink(`${E2E_DB_PATH}${suffix}`);
  }
  tryUnlink(E2E_PORT_FILE);
}
