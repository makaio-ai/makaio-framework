export type AdapterEnv = Record<string, string | undefined>;

/**
 * Clean environment variables for adapter child processes.
 *
 * Removes variables that should not be inherited by spawned adapter
 * processes (for example Claude Code SDK and CLI wrappers).
 *
 * SEAM: Extend this list as additional problematic environment variables
 * are discovered across adapter implementations.
 * @param env - Optional base environment to clean (defaults to `undefined`).
 * @returns Cleaned environment object with problematic variables removed.
 * @example
 * ```typescript
 * const session = query({
 *   options: {
 *     env: cleanEnvForAdapter(customEnv),
 *   },
 * });
 * ```
 */
export function cleanEnvForAdapter(env?: AdapterEnv): Record<string, string> {
  const result: Record<string, string> = {};
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
  }
  // Remove tsx/esm loader that breaks SDK spawning
  // (inherited from web-ui dev server: NODE_OPTIONS='--import tsx/esm')
  delete result['NODE_OPTIONS'];
  // Remove CLAUDECODE to allow spawning claude CLI as a subprocess even
  // when running inside another Claude Code session (e.g., during tests).
  delete result['CLAUDECODE'];
  return result;
}
