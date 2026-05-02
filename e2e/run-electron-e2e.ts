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
const frameworkRoot = path.resolve(import.meta.dirname, '..');
const playwrightConfigPath = path.join(frameworkRoot, 'apps/electron/e2e/playwright.config.ts');

const result = (() => {
  try {
    return spawnSync('yarn', ['playwright', 'test', '-c', playwrightConfigPath, ...process.argv.slice(2)], {
      stdio: 'inherit',
      cwd: frameworkRoot,
      env: {
        ...process.env,
        MAKAIO_E2E_PORT_FILE: portFile,
        MAKAIO_E2E_DB_PATH: dbPath,
      },
    });
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

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
