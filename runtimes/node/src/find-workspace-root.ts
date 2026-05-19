import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWorkspaceGlobs } from '@makaio/utils/workspace-packages';

/**
 * Error raised when no workspace root exists above the supplied start
 * directory.
 */
export class WorkspaceRootNotFoundError extends Error {
  /**
   * Creates a workspace-root lookup failure.
   * @param startDir - Directory where the workspace-root search started.
   */
  public constructor(startDir: string) {
    super(`[boot] Could not find workspace root (no package.json with 'workspaces' field) starting from: ${startDir}`);
    this.name = 'WorkspaceRootNotFoundError';
  }
}

/** Parsed workspace-root metadata from the nearest workspace package.json. */
export interface WorkspaceRootInfo {
  /** Absolute workspace root directory. */
  readonly root: string;
  /** Absolute path to the root package.json that declared workspaces. */
  readonly packageJsonPath: string;
  /** Workspace glob entries declared by the root package.json. */
  readonly workspaces: readonly string[];
}

/**
 * Walk up from `startDir` to find the nearest directory containing a
 * `package.json` with a `workspaces` field (the workspace root).
 *
 * Use {@link findWorkspaceRootInfo} when the caller also needs the parsed
 * workspace globs; that avoids re-reading the same root package.json.
 * @param startDir - Directory to start searching from.
 * @returns Absolute path to the workspace root.
 * @throws If no workspace root is found before reaching the filesystem root.
 */
export function findWorkspaceRoot(startDir: string): string {
  return findWorkspaceRootInfo(startDir).root;
}

/**
 * Walk up from `startDir` and return the nearest workspace root plus its
 * parsed workspace globs.
 * @param startDir - Directory to start searching from.
 * @returns Workspace root metadata.
 * @throws If no workspace root is found before reaching the filesystem root.
 */
export function findWorkspaceRootInfo(startDir: string): WorkspaceRootInfo {
  let current = path.resolve(startDir);

  while (true) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const raw = fs.readFileSync(pkgPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && 'workspaces' in parsed) {
          return {
            root: current,
            packageJsonPath: pkgPath,
            workspaces: parseWorkspaceGlobs(parsed),
          };
        }
      } catch {
        // Malformed package files are not workspace roots; keep walking upward.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new WorkspaceRootNotFoundError(startDir);
    }
    current = parent;
  }
}
