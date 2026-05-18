import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Seed `process.env['MAKAIO_HOME']` from the build-time default when the user
 * hasn't set it, so canary builds get an isolated data directory.
 * @param buildTimeDefault - Directory name injected at build time (e.g. `.makaio-canary`), or undefined to use `.makaio`.
 * @returns Resolved absolute MAKAIO_HOME path.
 */
export function seedMakaioHome(buildTimeDefault: string | undefined): string {
  const envHome = process.env['MAKAIO_HOME']?.trim() || '';
  if (envHome) return envHome;
  const dirName = buildTimeDefault ?? '.makaio';
  const resolved = path.join(os.homedir(), dirName);
  process.env['MAKAIO_HOME'] = resolved;
  return resolved;
}
