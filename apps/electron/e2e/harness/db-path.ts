/**
 * Temp file paths for Electron E2E runs.
 *
 * All paths support env-var overrides so the wrapper script
 * (run-electron-e2e.ts) can inject unique per-invocation values for CI
 * parallel safety.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Temp DB path — unique per run when set by wrapper script. */
export const E2E_DB_PATH = process.env['MAKAIO_E2E_DB_PATH'] ?? path.join(os.tmpdir(), 'makaio-electron-e2e.db');

/**
 * Shared port file for Playwright coordinator / worker communication.
 * Unique per run when set by wrapper script.
 */
export const E2E_PORT_FILE = process.env['MAKAIO_E2E_PORT_FILE'] ?? path.join(os.tmpdir(), 'makaio-electron-e2e-port');

/** SQLite sidecar suffixes created alongside the main database file. */
export const SQLITE_SIDECARS = ['-wal', '-shm'] as const;

/**
 * Silently unlink a file, ignoring ENOENT.
 * @param filePath - Absolute path to delete.
 */
export function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/**
 * Delete the temporary Electron e2e database and its SQLite sidecars.
 *
 * Shared by the Playwright webServer bootstrap and the headless Vitest smoke
 * harness so both entry points start from the same fresh-schema invariant.
 */
export function cleanupE2EDatabase(): void {
  for (const suffix of ['', ...SQLITE_SIDECARS]) {
    tryUnlink(`${E2E_DB_PATH}${suffix}`);
  }
}
