import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  AdapterFileSchema,
  PROVIDER_CONFIG_SCHEMA_VERSION,
  ProviderConfigFileSchema,
  type AdapterFile,
  type ProviderConfigFile,
} from '@makaio/contracts/config';
import type {
  AdapterFileConfigSet,
  IAdapterConfigRepository,
  ProviderConfigFileSet,
} from '@makaio/services-core/adapter-subsystem';
import type { ZodError } from 'zod';
import { ProviderConfigDiagnosticError } from './provider-config-diagnostic-error.js';

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
   * Unreadable, invalid-JSON, or schema-mismatched files are skipped with a warning.
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
        this.warnSkippedFile('adapter', entry.filePath, 'invalid-adapter-config', formatSchemaIssues(parsed.error));
        continue;
      }

      configs.set(fileStem, parsed.data);
    }

    return { configs };
  }

  /**
   * Load all validated provider config files from disk.
   *
   * Each non-conforming file (unreadable, invalid JSON, legacy v1 schema,
   * unsupported version, schema-invalid) is skipped with a per-file diagnostic
   * warning so a single stale or inaccessible file never aborts the boot sequence.
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

      try {
        configs.set(fileStem, this.parseProviderConfig(entry.jsonData, fileStem));
      } catch (error) {
        if (error instanceof ProviderConfigDiagnosticError) {
          this.warnSkippedFile('provider config', entry.filePath, error.code, error.message);
          continue;
        }
        throw error;
      }
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
    const filePath = path.join(this.providerConfigsDir, `${fileStem}${JSON_FILE_EXTENSION}`);
    const validated = this.parseProviderConfig(config, fileStem);
    await this.writeJsonFile(filePath, validated);
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
   *
   * Each per-file read or parse error is skipped with a warning so that one
   * inaccessible or malformed file does not prevent others from loading.
   * An ENOENT on the directory itself returns an empty array; any other
   * directory-level error is re-thrown.
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
            let reason: string;
            let detail: string;
            if (error instanceof SyntaxError) {
              reason = 'invalid-json';
              detail = 'file does not contain valid JSON.';
            } else {
              reason = 'unreadable';
              detail = error instanceof Error ? error.message : String(error);
            }
            this.warnSkippedFile(label, filePath, reason, detail);
            return null;
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
   * Emit a warning for a skipped file with a machine-readable reason code and
   * operator-actionable detail.
   * @param label - Human-readable file label (e.g. 'provider config', 'adapter').
   * @param filePath - Absolute path to the skipped file.
   * @param reason - Stable machine-readable reason code.
   * @param detail - Safe structural detail explaining the skip reason.
   */
  private warnSkippedFile(label: string, filePath: string, reason: string, detail: string): void {
    console.warn(
      '[FileAdapterConfigRepository] Skipping invalid %s file (%s): %s — %s',
      label,
      reason,
      filePath,
      detail,
    );
  }

  /**
   * Parse one canonical provider config without reinterpreting legacy fields.
   * @param value - Raw JSON or repository write input.
   * @param source - Safe provider-config ID used in diagnostics.
   * @returns Validated canonical provider config.
   */
  private parseProviderConfig(value: unknown, source: string): ProviderConfigFile {
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
    const schemaVersion = record?.$schema;
    const legacyFields = ['credentials', 'isSentinel'].filter((field) => Object.hasOwn(record ?? {}, field));

    if (schemaVersion === 'makaio/provider-config/v1' || legacyFields.length > 0) {
      const legacyDetails = [
        ...(schemaVersion === 'makaio/provider-config/v1' ? ['schema v1'] : []),
        ...(legacyFields.length > 0 ? [`legacy fields ${legacyFields.join(', ')}`] : []),
      ].join(' and ');
      throw new ProviderConfigDiagnosticError(
        'legacy-provider-config',
        source,
        `${legacyDetails} use retired authentication semantics. ` +
          'Recreate this config with an explicit normalized authentication method.',
      );
    }

    if (schemaVersion !== PROVIDER_CONFIG_SCHEMA_VERSION) {
      throw new ProviderConfigDiagnosticError(
        'unsupported-provider-config-version',
        source,
        `expected $schema "${PROVIDER_CONFIG_SCHEMA_VERSION}". Recreate the config with the current schema.`,
      );
    }

    const parsed = ProviderConfigFileSchema.safeParse(value);
    if (!parsed.success) {
      throw new ProviderConfigDiagnosticError('invalid-provider-config', source, formatSchemaIssues(parsed.error));
    }

    return parsed.data;
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
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.warnSkippedFile(label, filePath, 'invalid-file-name', detail);
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

/**
 * Format Zod validation issues into a single readable string.
 * @param error - Zod error from a failed `safeParse` or `parse` call.
 * @returns Semicolon-separated list of `path: message` entries.
 */
function formatSchemaIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}
