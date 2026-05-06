import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Silently unlink a file, ignoring ENOENT.
 * @param filePath - Absolute path to delete.
 */
function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

const portFile = path.join(os.tmpdir(), `makaio-electron-e2e-port-${process.pid}-${Date.now()}`);
const dbPath = path.join(os.tmpdir(), `makaio-electron-e2e-${process.pid}-${Date.now()}.db`);

const result = (() => {
  try {
    return spawnSync(
      'yarn',
      ['playwright', 'test', '-c', 'apps/electron/e2e/playwright.config.ts', ...process.argv.slice(2)],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          MAKAIO_E2E_PORT_FILE: portFile,
          MAKAIO_E2E_DB_PATH: dbPath,
        },
      },
    );
  } finally {
    tryUnlink(portFile);
    tryUnlink(dbPath);
    tryUnlink(`${dbPath}-wal`);
    tryUnlink(`${dbPath}-shm`);
  }
})();

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
