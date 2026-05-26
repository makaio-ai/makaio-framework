/**
 * Local path extension installer.
 *
 * Installs extensions from the local filesystem by creating symlinks in the
 * extensions directory, so the runtime can discover and load them without
 * copying files. Mutations are intentionally kept minimal: install creates a
 * symlink, uninstall removes it.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  isDetachedDescriptor,
  safeParseExtensionDescriptor,
  type ExtensionDescriptor,
  type ExtensionEntrypoints,
} from '@makaio/contracts';
import type { PackageInstallResult, PackageUninstallResult } from './schemas.js';

/**
 * An extension installed from the local filesystem.
 *
 * Returned by {@link LocalPathInstaller.list} for each symlink found in the
 * extensions directory whose descriptor can be successfully validated.
 */
export interface LocalExtensionEntry {
  /** Extension name as declared in `descriptor.json` (e.g. `'@acme/weather-tools'`). */
  readonly name: string;
  /** Extension version as declared in `descriptor.json`. */
  readonly version: string;
  /** Absolute path to the original extension directory (symlink target). */
  readonly sourcePath: string;
  /** Always `'local'` for entries managed by this installer. */
  readonly source: 'local';
  /** Absolute import path for the resolved server entrypoint, when present. */
  readonly serverImportPath?: string;
}

/**
 * Resolve a descriptor entrypoint using the runtime convention.
 * @param extensionDir - Absolute extension root path.
 * @param surface - Entrypoint surface.
 * @param entrypoint - Entrypoint declaration.
 * @returns Resolved entrypoint import path when valid.
 */
export async function resolveExtensionEntrypointImportPath(
  extensionDir: string,
  surface: keyof ExtensionEntrypoints,
  entrypoint: true | string,
): Promise<string | undefined> {
  if (!path.isAbsolute(extensionDir)) {
    return undefined;
  }

  let realExtensionDir: string;
  try {
    realExtensionDir = await fs.realpath(extensionDir);
  } catch {
    return undefined;
  }

  const stem = entrypointStem(surface, entrypoint);
  const candidates = [
    path.resolve(realExtensionDir, 'src', `${stem}.ts`),
    path.resolve(realExtensionDir, 'dist', `${stem}.mjs`),
  ];

  for (const candidate of candidates) {
    const realCandidate = await realpathIfExists(candidate);
    if (realCandidate !== undefined && isWithinDirectory(realCandidate, realExtensionDir)) {
      return realCandidate;
    }
  }

  return undefined;
}

/**
 * Convert a descriptor entrypoint declaration into its path stem.
 * @param surface - Entrypoint surface.
 * @param entrypoint - Entrypoint declaration.
 * @returns Entrypoint stem.
 */
function entrypointStem(surface: keyof ExtensionEntrypoints, entrypoint: true | string): string {
  return entrypoint === true ? surface : entrypoint;
}

/**
 * Resolve the real path for an existing file.
 * @param targetPath - Candidate path.
 * @returns Real path when the target exists.
 */
async function realpathIfExists(targetPath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return undefined;
  }
}

/**
 * Check whether a candidate path stays within an extension root.
 * @param candidate - Real candidate path.
 * @param extensionDir - Real extension root.
 * @returns Whether the candidate is contained by the root.
 */
function isWithinDirectory(candidate: string, extensionDir: string): boolean {
  const relative = path.relative(extensionDir, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Installs extensions from local filesystem paths via symlinks.
 *
 * Each installed extension is represented as a symbolic link inside
 * `extensionsDir`. Scoped names (e.g. `@acme/weather-tools`) produce a nested
 * path `extensionsDir/@acme/weather-tools`.
 *
 * Usage:
 * ```typescript
 * const installer = new LocalPathInstaller('~/.makaio/extensions');
 * await installer.install('./my-local-ext');
 * ```
 */
export class LocalPathInstaller {
  private readonly extensionsDir: string;

  /**
   * @param extensionsDir - Absolute path to the directory where extension
   *   symlinks are created (e.g. `~/.makaio/extensions`). The directory is
   *   created on demand during {@link install}.
   */
  public constructor(extensionsDir: string) {
    this.extensionsDir = path.resolve(extensionsDir);
  }

  /**
   * Install an extension from a local path by creating a symlink.
   *
   * If `sourcePath` points directly to a `descriptor.json` file, the parent
   * directory is used as the extension root. The descriptor is read and
   * validated before the symlink is created.
   * @param sourcePath - Absolute or relative path to the extension directory
   *   (or its `descriptor.json`).
   * @returns Result object describing whether installation succeeded.
   */
  public async install(sourcePath: string): Promise<PackageInstallResult> {
    try {
      const extDir = path.resolve(sourcePath.endsWith('descriptor.json') ? path.dirname(sourcePath) : sourcePath);
      const realExtDir = await fs.realpath(extDir);

      const descriptor = await this.readDescriptor(realExtDir);
      if (!isDetachedDescriptor(descriptor)) {
        await this.validateEntrypoints(realExtDir, descriptor.entrypoints);
      }
      const linkPath = this.linkPathFor(descriptor.name);

      await fs.mkdir(path.dirname(linkPath), { recursive: true });

      try {
        const existing = await fs.lstat(linkPath);
        if (existing.isSymbolicLink()) {
          await fs.unlink(linkPath);
        } else {
          throw new Error(`${linkPath} already exists and is not a symlink`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      await fs.symlink(realExtDir, linkPath, symlinkType);

      return {
        success: true,
        packageName: descriptor.name,
        version: descriptor.version,
        restartRequired: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, packageName: '', error: message, restartRequired: false };
    }
  }

  /**
   * Uninstall an extension by removing its symlink from the extensions directory.
   * @param extensionName - Extension name as declared in `descriptor.json`
   *   (e.g. `'my-ext'` or `'@acme/weather-tools'`).
   * @returns Result object describing whether uninstallation succeeded.
   */
  public async uninstall(extensionName: string): Promise<PackageUninstallResult> {
    try {
      const linkPath = this.linkPathFor(extensionName);
      await fs.unlink(linkPath);

      // Remove the scope directory if it is now empty (best-effort)
      if (extensionName.startsWith('@')) {
        const scopeDir = path.dirname(linkPath);
        const remaining = await fs.readdir(scopeDir).catch(() => null);
        if (remaining?.length === 0) {
          await fs.rmdir(scopeDir).catch(() => {
            // Non-fatal: another process may have raced us here.
          });
        }
      }

      return { success: true, packageName: extensionName, restartRequired: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, packageName: extensionName, error: message, restartRequired: false };
    }
  }

  /**
   * List all locally installed extensions by scanning the extensions directory
   * for symlinks and reading their descriptors.
   *
   * Entries whose symlink target has an unreadable or invalid descriptor are
   * silently skipped so a single corrupt link never blocks the full listing.
   * @returns Entries for every valid locally installed extension, or an empty
   *   array when the extensions directory does not yet exist.
   */
  public async list(): Promise<LocalExtensionEntry[]> {
    try {
      await fs.access(this.extensionsDir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(this.extensionsDir);
    const results: LocalExtensionEntry[] = [];

    for (const entry of entries) {
      const entryPath = path.join(this.extensionsDir, entry);

      if (entry.startsWith('@')) {
        // Scoped namespace directory — scan one level deeper.
        const scopedEntries = await fs.readdir(entryPath).catch(() => []);
        for (const scopedPkg of scopedEntries) {
          const pkgPath = path.join(entryPath, scopedPkg);
          const localEntry = await this.readLocalEntry(pkgPath);
          if (localEntry !== null) {
            results.push(localEntry);
          }
        }
      } else {
        const localEntry = await this.readLocalEntry(entryPath);
        if (localEntry !== null) {
          results.push(localEntry);
        }
      }
    }

    return results;
  }

  /**
   * Read a symlink's target descriptor and produce a {@link LocalExtensionEntry}.
   *
   * Returns `null` when the path is not a symlink, the target is unreadable, or
   * the descriptor fails validation — callers should skip nulls gracefully.
   * @param linkPath - Absolute path to the candidate symlink.
   * @returns A populated entry or `null` on any failure.
   */
  private async readLocalEntry(linkPath: string): Promise<LocalExtensionEntry | null> {
    try {
      const stat = await fs.lstat(linkPath);
      if (!stat.isSymbolicLink()) {
        return null;
      }

      const rawTarget = await fs.readlink(linkPath);
      const sourcePath = await fs.realpath(path.resolve(path.dirname(linkPath), rawTarget));
      const descriptorPath = path.join(sourcePath, 'descriptor.json');
      const raw = await fs.readFile(descriptorPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const result = safeParseExtensionDescriptor(parsed);
      if (!result.success) {
        return null;
      }

      const serverEntrypoint = result.data.entrypoints?.server;
      const serverImportPath =
        serverEntrypoint === undefined
          ? undefined
          : await resolveExtensionEntrypointImportPath(sourcePath, 'server', serverEntrypoint);

      return {
        name: result.data.name,
        version: result.data.version,
        sourcePath,
        source: 'local',
        ...(serverImportPath !== undefined && { serverImportPath }),
      };
    } catch {
      return null;
    }
  }

  /**
   * Read and validate an extension descriptor from a local extension root.
   * @param extensionDir - Absolute real path to the extension root.
   * @returns Parsed extension descriptor.
   */
  private async readDescriptor(extensionDir: string): Promise<ExtensionDescriptor> {
    const descriptorPath = path.join(extensionDir, 'descriptor.json');
    const raw = await fs.readFile(descriptorPath, 'utf-8').catch(() => {
      throw new Error(`descriptor.json not found at ${descriptorPath}`);
    });

    const parsed = JSON.parse(raw) as unknown;
    const result = safeParseExtensionDescriptor(parsed);
    if (!result.success) {
      throw new Error(`Invalid descriptor.json: ${result.error.message}`);
    }

    return result.data;
  }

  /**
   * Verify every declared descriptor entrypoint has a convention-resolved file
   * contained within the extension root.
   * @param extensionDir - Absolute real path to the extension root.
   * @param entrypoints - Descriptor entrypoint declarations.
   */
  private async validateEntrypoints(extensionDir: string, entrypoints: ExtensionEntrypoints): Promise<void> {
    await Promise.all(
      (Object.entries(entrypoints) as Array<[keyof ExtensionEntrypoints, true | string | undefined]>).map(
        async ([surface, entrypoint]) => {
          if (entrypoint === undefined) {
            return;
          }

          const resolved = await resolveExtensionEntrypointImportPath(extensionDir, surface, entrypoint);
          if (resolved === undefined) {
            const stem = entrypointStem(surface, entrypoint);
            throw new Error(
              `${surface} entrypoint "${stem}" has no resolvable candidate: neither src/${stem}.ts nor dist/${stem}.mjs exists within the extension root`,
            );
          }
        },
      ),
    );
  }

  /**
   * Compute the absolute symlink path for a given extension name.
   *
   * For scoped names (e.g. `@acme/weather-tools`) the link lives at
   * `extensionsDir/@acme/weather-tools`. For unscoped names it is simply
   * `extensionsDir/<name>`.
   * @param extensionName - Extension name from `descriptor.json`.
   * @returns Absolute path where the symlink should be created.
   */
  private linkPathFor(extensionName: string): string {
    const linkPath = path.resolve(this.extensionsDir, ...extensionName.split('/'));
    const relative = path.relative(this.extensionsDir, linkPath);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Invalid extension name: ${extensionName}`);
    }
    return linkPath;
  }
}
