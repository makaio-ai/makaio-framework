import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read the framework version from `@makaio/runtime-node`'s `package.json`.
 *
 * Resolves `package.json` relative to the compiled source using
 * `import.meta.url`, which is always available in ESM. Used as a fallback
 * when the caller does not pass an explicit `frameworkVersion`.
 * @returns The `version` field from `package.json`.
 * @throws If `package.json` cannot be read or has no `version` field.
 */
export async function readFrameworkVersion(): Promise<string> {
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(srcDir, '..', 'package.json');
  const raw = await fs.readFile(pkgPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error(`[boot] package.json at ${pkgPath} has no string 'version' field`);
  }
  return parsed.version;
}
