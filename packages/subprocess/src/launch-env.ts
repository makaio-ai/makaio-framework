import type { SpawnEnvMode, SubprocessSpawnOptions } from './types.js';

/**
 * Build the child's environment: `undefined` values remove an entry, and under
 * `merge` they remove an inherited one. On `win32` names are case-insensitive, so a
 * base entry is replaced or removed by an override whose name differs only in case.
 * @param base - The host environment; ignored under `replace`.
 * @param env - Entries of the caller.
 * @param mode - Whether the host environment is the base.
 * @param platform - The platform whose name rules apply.
 * @returns The environment to spawn with.
 */
export function mergeEnvironment(
  base: NodeJS.ProcessEnv,
  env: SubprocessSpawnOptions['env'],
  mode: SpawnEnvMode,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const overrides = env ?? {};
  const inherited = mode === 'merge' ? base : {};
  const overridden = new Set(Object.keys(overrides).map((name) => name.toUpperCase()));
  const kept =
    platform === 'win32'
      ? Object.entries(inherited).filter(([name]) => !overridden.has(name.toUpperCase()))
      : Object.entries(inherited);
  const merged = { ...Object.fromEntries(kept), ...overrides };
  return Object.fromEntries(Object.entries(merged).filter((entry) => entry[1] !== undefined));
}
