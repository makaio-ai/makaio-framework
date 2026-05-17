import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the workspace root from a package directory 2-4 levels below the root.
 *
 * Supports two source layouts:
 * - **Prefixed source layout**: workspace root contains `framework/package.json`;
 *   the workspace root is the nearest ancestor (up to 4 levels) that contains
 *   `framework/package.json`.
 * - **Package-root layout**: workspace root contains `package.json` directly;
 *   the workspace root is the nearest ancestor that contains `package.json`.
 *
 * Resolution walks bounded candidate depths from shallowest to deepest. A
 * package root named `framework` is treated as nested source layout only when
 * its parent contains that directory as a workspace marker; other package roots
 * win immediately so checkouts embedded in another workspace do not overshoot.
 * @param packageDir - Absolute path to a package directory inside the repo
 *   (e.g. the value of `path.dirname(fileURLToPath(import.meta.url))`).
 * @returns Absolute path to the workspace root.
 * @throws If neither supported source layout is detected at any candidate depth.
 */
export function resolveWorkspaceRoot(packageDir: string): string {
  if (!path.isAbsolute(packageDir)) {
    throw new Error(`[workspace-root] packageDir must be absolute. Received: "${packageDir}"`);
  }
  // Depth is intentionally bounded to 2-4 levels. All known call sites live
  // within that range (for example, framework package src directories are
  // usually 4 levels below the root). A dynamic upward walk would risk matching unrelated package.json
  // files higher in the filesystem — the bounded list is a safety constraint.
  const candidates = [
    path.resolve(packageDir, '../..'),
    path.resolve(packageDir, '../../..'),
    path.resolve(packageDir, '../../../..'),
  ];

  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'package.json'))) {
      const parentDir = path.dirname(candidate);
      if (path.basename(candidate) === 'framework' && existsSync(path.join(parentDir, 'framework', 'package.json'))) {
        return parentDir;
      }
      return candidate;
    }
  }

  throw new Error(
    `[workspace-root] Could not resolve workspace root from "${packageDir}". Checked:\n${candidates
      .map((c) => `- ${c}`)
      .join('\n')}`,
  );
}
