/**
 * Runtime detection utilities.
 *
 * Provides a single, canonical implementation of runtime checks used across
 * framework packages and host extensions.
 * @packageDocumentation
 */

/**
 * Returns `true` when the current process is running under the Bun runtime.
 *
 * Detection is based on the presence of the `Bun` property on `globalThis`,
 * which Bun always exposes. Uses a bracket-access check to avoid a TypeScript
 * error on environments where the `Bun` global is not declared.
 * @returns Whether the current runtime is Bun.
 */
export function isBunRuntime(): boolean {
  return typeof (globalThis as Record<string, unknown>)['Bun'] !== 'undefined';
}
