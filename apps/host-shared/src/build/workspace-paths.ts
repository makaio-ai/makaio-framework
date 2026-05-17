import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';

/**
 * Resolve the storage-migrations drizzle directory across both supported source layouts.
 *
 * The framework may live at the repository root or under a source-tree prefix
 * during local development. This helper accepts either layout and returns the
 * first existing migrations directory.
 * @param packageRoot - Absolute path to the host package root.
 * @returns Absolute path to the framework storage-migrations drizzle folder.
 * @throws If neither supported source layout contains the migrations directory.
 */
export function resolveStorageMigrationsDir(packageRoot: string): string {
  const workspaceRoot = resolveWorkspaceRoot(packageRoot);
  const candidates = [
    path.join(workspaceRoot, 'packages', 'storage-migrations', 'drizzle'),
    path.join(workspaceRoot, 'framework', 'packages', 'storage-migrations', 'drizzle'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `[host-build] Could not resolve storage migrations directory. Checked:\n${candidates
      .map((candidate) => `- ${candidate}`)
      .join('\n')}`,
  );
}
