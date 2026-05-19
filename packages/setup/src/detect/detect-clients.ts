import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import type { DetectedClient, SetupClientEntry } from '../types.js';

/**
 * Expands a tilde prefix to the user's home directory.
 * @param p - A path that may start with `~/`.
 * @returns The resolved absolute path.
 */
function expandTilde(p: string): string {
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
}

/**
 * Checks whether at least one of the given paths exists on disk.
 * @param paths - Paths to check (may contain `~` prefix).
 * @returns True if at least one path is accessible.
 */
async function anyPathExists(paths: readonly string[]): Promise<boolean> {
  const results = await Promise.all(
    paths.map(async (p) => {
      try {
        await access(expandTilde(p));
        return true;
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

/**
 * Reads PATH using a case-insensitive lookup so copied/custom environment
 * objects behave like Windows' case-insensitive process environment.
 * @returns The current PATH value, or an empty string when absent.
 */
function readPathValue(): string {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  return process.env[pathKey] ?? '';
}

/**
 * Checks whether a binary name resolves from the current PATH.
 * @param binaryName - Executable name to find.
 * @returns True when PATH contains an executable with this name.
 */
async function binaryExistsOnPath(binaryName: string): Promise<boolean> {
  const pathValue = readPathValue();
  const pathExts = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const candidates = pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => pathExts.map((ext) => join(entry, `${binaryName}${ext}`)));

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
  return results.some(Boolean);
}

/**
 * Detects which AI clients from the catalog are present on this machine.
 * @param catalog - The client catalog to scan.
 * @returns Detection results for each catalog entry, in catalog order.
 */
export async function detectClients(catalog: readonly SetupClientEntry[]): Promise<DetectedClient[]> {
  return Promise.all(
    catalog.map(async (entry) => {
      const [foundConfig, foundBinary] = await Promise.all([
        anyPathExists(entry.detectPaths),
        binaryExistsOnPath(entry.binaryName),
      ]);
      return {
        entry,
        detected: foundConfig || foundBinary,
      };
    }),
  );
}

/**
 * Resolves the deduplicated list of extension packages for the selected client IDs.
 * Iterates the catalog in declared order and deduplicates across clients.
 * @param catalog - The full client catalog.
 * @param selectedIds - Client IDs chosen by the user.
 * @returns Ordered, deduplicated package names.
 */
export function resolveSelectedExtensionPackages(
  catalog: readonly SetupClientEntry[],
  selectedIds: readonly string[],
): string[] {
  const selected = new Set(selectedIds);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of catalog) {
    if (!selected.has(entry.clientId)) continue;
    for (const pkg of entry.extensionPackages) {
      if (seen.has(pkg)) continue;
      seen.add(pkg);
      result.push(pkg);
    }
  }

  return result;
}
