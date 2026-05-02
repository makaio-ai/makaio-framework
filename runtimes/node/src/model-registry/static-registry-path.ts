import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';

/**
 * Resolve the source-tree static model registry YAML when running from a repo checkout.
 *
 * Packaged Electron bundles run from `app.asar/dist`, where no workspace root
 * exists. In that case the static source-tree fallback is unavailable and the
 * registry fetcher chain should continue with the other configured sources.
 * @param baseDir - Absolute directory inside the source workspace when available
 * @returns Static model registry path, or `undefined` outside a source checkout
 */
export function resolveStaticModelRegistryPath(baseDir: string): string | undefined {
  try {
    const registryPath = path.resolve(resolveWorkspaceRoot(baseDir), 'static/model-registry.yaml');
    return existsSync(registryPath) ? registryPath : undefined;
  } catch {
    return undefined;
  }
}
