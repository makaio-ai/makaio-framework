import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach } from 'vitest';

/**
 * Create a scoped temp directory helper with automatic cleanup.
 *
 * Call at module scope; registers an `afterEach` hook that removes all
 * directories created during the test.
 * @param prefix - Prefix for `fs.mkdtemp` (e.g. `'edit-file-'`).
 * @returns A `createTempDir` function that creates and tracks temp dirs.
 */
export function useTempDir(prefix: string): () => Promise<string> {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0, dirs.length).map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
      }),
    );
  });

  return async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}
