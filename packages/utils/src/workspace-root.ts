import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve the workspace root from a package directory 2–4 levels below the root.
 *
 * Supports two source layouts:
 * - **Parent workspace layout**: workspace root contains `framework/package.json`;
 *   the workspace root is the nearest ancestor (up to 4 levels) that contains
 *   `framework/package.json`.
 * - **Package-root layout**: workspace root contains `package.json` directly;
 *   the workspace root is the nearest ancestor that contains `package.json`.
 *
 * Resolution uses two passes over bounded candidate depths (2–4 levels up):
 * 1. **Nested-layout pass** — prefer the shallowest candidate containing
 *    `framework/package.json` (avoids overshooting into a parent workspace).
 * 2. **Package-root fallback** — if no nested-layout marker is found, accept the
 *    shallowest candidate containing `package.json`.
 *
 * The two-pass approach prevents a bare `package.json` above the repo root
 * from being mistakenly selected when the nested-layout marker is present deeper.
 * @param packageDir - Absolute path to a package directory inside the repo
 *   (e.g. the value of `path.dirname(fileURLToPath(import.meta.url))`).
 * @returns Absolute path to the workspace root.
 * @throws If neither supported source layout is detected at any candidate depth.
 */
export function resolveWorkspaceRoot(packageDir: string): string {
  if (!path.isAbsolute(packageDir)) {
    throw new Error(`[workspace-root] packageDir must be absolute. Received: "${packageDir}"`);
  }
  // Depth is intentionally bounded to 2–4 levels. All known call sites live
  // within that range (for example, framework package src directories are
  // usually 4 levels below the root). A dynamic upward walk would risk matching unrelated package.json
  // files higher in the filesystem — the bounded list is a safety constraint.
  const candidates = [
    path.resolve(packageDir, '../..'),
    path.resolve(packageDir, '../../..'),
    path.resolve(packageDir, '../../../..'),
  ];

  // Pass 1: prefer the nested-layout marker (framework/package.json).
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'framework', 'package.json'))) {
      return candidate;
    }
  }

  // Pass 2: standalone fallback — bare package.json at the shallowest match.
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }

  throw new Error(
    `[workspace-root] Could not resolve workspace root from "${packageDir}". Checked:\n${candidates
      .map((c) => `- ${c}`)
      .join('\n')}`,
  );
}
