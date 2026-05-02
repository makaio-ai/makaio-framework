import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  AdapterFileSchema,
  ProviderConfigFileSchema,
  type AdapterFile,
  type ProviderConfigFile,
} from '@makaio/contracts/config';
import type {
  AdapterFileConfigSet,
  IAdapterConfigRepository,
  ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';

const JSON_FILE_EXTENSION = '.json';

/**
 * Options for creating a file-backed adapter config repository.
 */
export interface FileAdapterConfigRepositoryOptions {
  /**
   * Absolute directory containing provider config JSON files.
   */
  readonly providerConfigsDir: string;
  /**
   * Absolute directory containing adapter config JSON files.
   */
  readonly adaptersDir: string;
}

/**
 * File-backed repository for adapter subsystem config entities.
 *
 * Provider configs and adapter configs are stored in host-provided directories.
 * The file stem is the canonical entity ID for both collections.
 */
export class FileAdapterConfigRepository implements IAdapterConfigRepository {
  private readonly providerConfigsDir: string;
  private readonly adaptersDir: string;

  /**
   * Create a new file-backed adapter config repository.
   * @param options - Repository options.
   */
  public constructor(options: FileAdapterConfigRepositoryOptions) {
    this.providerConfigsDir = options.providerConfigsDir;
    this.adaptersDir = options.adaptersDir;
  }

  /**
   * Load all validated adapter config files from disk.
   * Invalid JSON or schema mismatches are skipped.
   * @returns Validated adapter config file set.
   */
  public async loadAdapterConfigs(): Promise<AdapterFileConfigSet> {
    const configs = new Map<string, AdapterFile>();
    const entries = await this.readJsonFiles(this.adaptersDir, 'adapter');

    for (const entry of entries) {
      const fileStem = this.getCanonicalLoadedStem(entry.stem, 'adapter', entry.filePath);
      if (!fileStem) {
        continue;
      }

      const parsed = AdapterFileSchema.safeParse(entry.jsonData);
      if (!parsed.success) {
        this.warnInvalidFile('adapter', entry.filePath);
        continue;
      }

      configs.set(fileStem, parsed.data);
    }

    return { configs };
  }

  /**
   * Load all validated provider config files from disk.
   * Invalid JSON or schema mismatches are skipped.
   * @returns Validated provider config file set.
   */
  public async loadProviderConfigs(): Promise<ProviderConfigFileSet> {
    const configs = new Map<string, ProviderConfigFile>();
    const entries = await this.readJsonFiles(this.providerConfigsDir, 'provider config');

    for (const entry of entries) {
      const fileStem = this.getCanonicalLoadedStem(entry.stem, 'provider config', entry.filePath);
      if (!fileStem) {
        continue;
      }

      const parsed = ProviderConfigFileSchema.safeParse(entry.jsonData);
      if (!parsed.success) {
        this.warnInvalidFile('provider config', entry.filePath);
        continue;
      }

      configs.set(fileStem, parsed.data);
    }

    return { configs };
  }

  /**
   * Persist a validated provider config file to disk.
   * @param id - Canonical provider config ID, derived from the file stem.
   * @param config - Provider config payload to persist.
   */
  public async writeProviderConfig(id: string, config: ProviderConfigFile): Promise<void> {
    const fileStem = this.assertCanonicalFileStem(id, 'provider config id');
    const validated = ProviderConfigFileSchema.parse(config);
    await this.writeJsonFile(path.join(this.providerConfigsDir, `${fileStem}${JSON_FILE_EXTENSION}`), validated);
  }

  /**
   * Delete a provider config file from disk.
   * @param id - Canonical provider config ID, derived from the file stem.
   * @returns `true` when a file was removed.
   */
  public async deleteProviderConfig(id: string): Promise<boolean> {
    const fileStem = this.assertCanonicalFileStem(id, 'provider config id');

    try {
      await this.unlinkFile(path.join(this.providerConfigsDir, `${fileStem}${JSON_FILE_EXTENSION}`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }

      throw error;
    }
  }

  /**
   * Persist a validated adapter config file to disk.
   * @param name - Canonical adapter name, derived from the file stem.
   * @param config - Adapter config payload to persist.
   */
  public async writeAdapterFile(name: string, config: AdapterFile): Promise<void> {
    const fileStem = this.assertCanonicalFileStem(name, 'adapter name');
    const validated = AdapterFileSchema.parse(config);
    await this.writeJsonFile(path.join(this.adaptersDir, `${fileStem}${JSON_FILE_EXTENSION}`), validated);
  }

  /**
   * Delete an adapter config file from disk.
   * @param name - Canonical adapter name, derived from the file stem.
   * @returns `true` when a file was removed.
   */
  public async deleteAdapterFile(name: string): Promise<boolean> {
    const fileStem = this.assertCanonicalFileStem(name, 'adapter name');

    try {
      await this.unlinkFile(path.join(this.adaptersDir, `${fileStem}${JSON_FILE_EXTENSION}`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }

      throw error;
    }
  }

  /**
   * Read raw JSON files from a directory, returning an empty array when missing.
   * @param directoryPath - Directory to scan.
   * @param label - Human-readable file label for warnings.
   * @returns JSON file entries sorted by file name.
   */
  private async readJsonFiles(
    directoryPath: string,
    label: string,
  ): Promise<Array<{ filePath: string; stem: string; jsonData: unknown }>> {
    try {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && path.extname(entry.name) === JSON_FILE_EXTENSION)
        .sort((left, right) => left.name.localeCompare(right.name));

      const fileContents = await Promise.all(
        files.map(async (entry) => {
          const filePath = path.join(directoryPath, entry.name);
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            return { filePath, stem: path.parse(entry.name).name, jsonData: JSON.parse(content) };
          } catch (error) {
            if (
              error instanceof SyntaxError ||
              (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')
            ) {
              this.warnInvalidFile(label, filePath);
              return null;
            }
            throw error;
          }
        }),
      );

      return fileContents.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }

  /**
   * Emit a warning for a skipped invalid file.
   * @param label - Human-readable file label.
   * @param filePath - Absolute path to the skipped file.
   */
  private warnInvalidFile(label: string, filePath: string): void {
    console.warn('[FileAdapterConfigRepository] Skipping invalid %s file: %s', label, filePath);
  }

  /**
   * Check a loaded JSON file stem before accepting it as a canonical ID.
   * @param stem - File stem derived from the directory entry.
   * @param label - Human-readable file label.
   * @param filePath - Absolute file path for diagnostics.
   * @returns Canonical file stem, or null when the filename is invalid.
   */
  private getCanonicalLoadedStem(stem: string, label: string, filePath: string): string | null {
    try {
      return this.assertCanonicalFileStem(stem, `${label} file stem`);
    } catch {
      this.warnInvalidFile(label, filePath);
      return null;
    }
  }

  /**
   * Write a JSON file, creating parent directories on demand.
   * @param filePath - Absolute output file path.
   * @param value - Validated JSON value to persist.
   */
  private async writeJsonFile(filePath: string, value: AdapterFile | ProviderConfigFile): Promise<void> {
    const directoryPath = path.dirname(filePath);
    const temporaryFilePath = path.join(directoryPath, `.${path.basename(filePath)}.${randomUUID()}.tmp`);

    await fs.mkdir(directoryPath, { recursive: true });

    try {
      await fs.writeFile(temporaryFilePath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600,
      });
      await this.replaceFile(temporaryFilePath, filePath);
    } catch (error) {
      await this.removeFileIfPresent(temporaryFilePath);
      throw error;
    }
  }

  /**
   * Atomically replace a visible config file with a prepared temp file.
   * @param sourcePath - Fully written temp file path.
   * @param targetPath - Visible config file path.
   */
  protected async replaceFile(sourcePath: string, targetPath: string): Promise<void> {
    try {
      await this.renameFile(sourcePath, targetPath);
      return;
    } catch (error) {
      const renameError = error as NodeJS.ErrnoException;
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(renameError.code ?? '')) {
        throw error;
      }
    }

    const backupPath = `${targetPath}.${randomUUID()}.bak`;
    let backupCreated = false;

    try {
      await this.renameFile(targetPath, backupPath);
      backupCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    try {
      await this.renameFile(sourcePath, targetPath);
    } catch (error) {
      if (backupCreated) await this.renameFile(backupPath, targetPath).catch(() => undefined);
      throw error;
    }

    if (backupCreated) await this.removeFileIfPresent(backupPath);
  }

  /**
   * Rename a file path.
   * Extracted as a protected seam so repository tests can simulate platform-
   * specific rename behavior without mocking the ESM fs namespace.
   * @param sourcePath - Existing source path.
   * @param targetPath - Desired target path.
   */
  protected async renameFile(sourcePath: string, targetPath: string): Promise<void> {
    await fs.rename(sourcePath, targetPath);
  }

  /**
   * Delete a file path.
   * @param filePath - Path to delete.
   */
  protected async unlinkFile(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  /**
   * Remove a temp file without surfacing "already gone" noise.
   * @param filePath - Temp file path.
   */
  protected async removeFileIfPresent(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[FileAdapterConfigRepository] Failed to remove temp file: %s', filePath, error);
      }
    }
  }

  /**
   * Validate that an ID is already canonical and safe to use as a file stem.
   * @param value - Caller-supplied ID or name.
   * @param label - Human-readable label for the failing field.
   * @returns Canonical file stem.
   */
  private assertCanonicalFileStem(value: string, label: string): string {
    const trimmed = value.trim();
    const baseName = path.basename(trimmed);

    if (
      !trimmed ||
      value !== trimmed ||
      trimmed !== baseName ||
      !/^[a-z0-9._-]+$/.test(trimmed) ||
      trimmed.includes('/') ||
      trimmed.includes('\\') ||
      trimmed.toLowerCase().endsWith('.json') ||
      trimmed === '.' ||
      trimmed === '..'
    ) {
      throw new Error(`Invalid canonical ${label}: ${value}`);
    }

    return trimmed;
  }
}
