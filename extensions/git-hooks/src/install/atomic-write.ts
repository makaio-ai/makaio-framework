import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Write content through a uniquely named, exclusively created temp file and
 * atomically rename it into place.
 * @param targetPath - Final file path.
 * @param content - UTF-8 content to write.
 * @param mode - Optional mode to apply before rename.
 * @returns Resolves after the temp file has been renamed into place.
 */
export async function writeFileAtomicExclusive(targetPath: string, content: string, mode?: number): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const tmpPath = path.join(dir, `.${base}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeTempAndRename(tmpPath, targetPath, content, mode);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`[git-hooks] Could not allocate a unique temp file for ${targetPath}.`);
}

/**
 * Write the temp file, chmod it when needed, and rename it into place.
 * @param tmpPath - Unique temp file path created in the target directory.
 * @param targetPath - Final file path to replace.
 * @param content - UTF-8 content to write.
 * @param mode - Optional mode to apply before rename.
 * @returns Resolves after the rename completes.
 */
async function writeTempAndRename(
  tmpPath: string,
  targetPath: string,
  content: string,
  mode: number | undefined,
): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, 'wx', mode);
    await handle.writeFile(content, 'utf8');
    await handle.close();
    handle = undefined;
    if (mode !== undefined) {
      await fs.chmod(tmpPath, mode);
    }
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}
