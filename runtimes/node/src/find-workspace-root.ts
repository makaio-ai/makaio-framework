import * as fs from 'node:fs';
import * as path from 'node:path';

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

/**
 * Walk up from `startDir` to find the nearest directory containing a
 * `package.json` with a `workspaces` field (the workspace root).
 *
 * Intentionally synchronous — this runs once at boot before any async work
 * begins, and the synchronous API avoids async complexity at the call site.
 * @param startDir - Directory to start searching from.
 * @returns Absolute path to the workspace root.
 * @throws If no workspace root is found before reaching the filesystem root.
 */
export function findWorkspaceRoot(startDir: string): string {
  let current = path.resolve(startDir);

  while (true) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const raw = fs.readFileSync(pkgPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && 'workspaces' in parsed) {
          return current;
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
