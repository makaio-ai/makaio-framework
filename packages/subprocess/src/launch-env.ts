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

/**
 * Build a replacement environment for the bounded launcher.
 * Node copies its coverage directory into a custom environment unless the
 * coverage key is an own property. An undefined value blocks the copy without
 * adding the variable to the spawned process.
 * @param env - Explicit environment for the child.
 * @param platform - Name casing rules of the host.
 * @returns The environment to pass to Node.
 */
export function replacementSpawnEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const coverage = 'NODE_V8_COVERAGE';
  const key = platform === 'win32' ? Object.keys(env).find((name) => name.toUpperCase() === coverage) : coverage;
  const value = key === undefined ? undefined : env[key];
  const prepared: NodeJS.ProcessEnv = { ...env, [coverage]: value };
  if (key !== undefined && key !== coverage) delete prepared[key];
  Object.setPrototypeOf(prepared, null);
  return prepared;
}
