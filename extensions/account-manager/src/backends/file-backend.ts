import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ICredentialBackend } from './credential-backend.js';

/**
 * File-based credential backend.
 *
 * Reads and writes credentials as UTF-8 text files with restricted
 * permissions (`0o600`). Writes are atomic (write to temp file, rename).
 */
export class FileBackend implements ICredentialBackend {
  /**
   * @param path - Absolute path to the credential file
   */
  public constructor(private readonly path: string) {}

  /**
   * Reads the credential value from the configured file path.
   *
   * Returns null if the file does not exist.
   * @returns The file contents as a UTF-8 string, or null if not found
   */
  public async read(): Promise<string | null> {
    try {
      return await readFile(this.path, 'utf-8');
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Writes a credential value to the configured file path atomically.
   *
   * Writes to a `.tmp` sibling file first, then renames to the final path
   * to avoid partial writes. The file is created with mode `0o600`.
   * @param value - The credential string to write
   */
  public async write(value: string): Promise<void> {
    const tmpPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, value, { encoding: 'utf-8', mode: 0o600 });
      await rename(tmpPath, this.path);
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  /** Remove the configured credential file when it exists. */
  public async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  /**
   * Rebind this credential filename below a pinned canonical config directory.
   * @param configDir - Canonical directory verified by the source.
   * @returns File backend that no longer follows the caller's lexical alias.
   */
  public bindToCanonicalConfigDirectory(configDir: string): ICredentialBackend {
    return new FileBackend(join(configDir, basename(this.path)));
  }
}
