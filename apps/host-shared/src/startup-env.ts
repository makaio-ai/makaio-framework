/**
 * Startup environment resolution for the desktop host main process.
 *
 * Reads and validates environment variables for initial window configuration.
 * All functions are pure utilities over `process.env` with no side effects.
 */

/** Framework-owned fallback window used when no initial window is configured. */
export const FRAMEWORK_FALLBACK_WINDOW = 'framework-shell:main';

/**
 * Resolved startup window state.
 *
 * `isOverride` tracks the raw presence of `MAKAIO_INITIAL_WINDOW`, not whether
 * the resolved ID differs from the framework fallback. That lets hosts bypass
 * session restore even when the explicit override points at
 * {@link FRAMEWORK_FALLBACK_WINDOW}.
 */
export interface InitialWindowState {
  /** Qualified window registration ID to open on startup. */
  readonly registrationId: string;
  /** Whether `MAKAIO_INITIAL_WINDOW` was explicitly provided. */
  readonly isOverride: boolean;
}

/**
 * Resolve the initial window startup state from `MAKAIO_INITIAL_WINDOW`.
 *
 * The value is treated as a qualified ID (`{packageName}:{windowId}`). No
 * validation against the registry is performed here — an unknown ID will
 * result in an error from `WindowManager.createWindow` at startup, which is
 * the appropriate fail-fast behavior.
 *
 * The returned `isOverride` flag is true for any non-blank env value, including
 * the framework fallback ID, so hosts can bypass session restore on explicit
 * startup overrides without duplicating fallback comparisons.
 * @param env - The process environment to read from.
 * @returns The resolved startup window state.
 */
export function resolveInitialWindowState(env: NodeJS.ProcessEnv = process.env): InitialWindowState {
  const normalized = env['MAKAIO_INITIAL_WINDOW']?.trim();
  if (normalized) {
    return {
      registrationId: normalized,
      isOverride: true,
    };
  }

  return {
    registrationId: FRAMEWORK_FALLBACK_WINDOW,
    isOverride: false,
  };
}

/**
 * Resolves the initial window registration ID from the `MAKAIO_INITIAL_WINDOW`
 * environment variable.
 *
 * The value is treated as a qualified ID (`{packageName}:{windowId}`). No
 * validation against the registry is performed here — an unknown ID will
 * result in an error from `WindowManager.createWindow` at startup, which is
 * the appropriate fail-fast behavior.
 *
 * Falls back to {@link FRAMEWORK_FALLBACK_WINDOW} when the variable is absent.
 * @param env - The process environment to read from.
 * @returns The qualified window registration ID to open on startup.
 */
export function resolveInitialWindowId(env: NodeJS.ProcessEnv = process.env): string {
  return resolveInitialWindowState(env).registrationId;
}

/**
 * Reads `MAKAIO_INITIAL_<KEY>` env vars (excluding `MAKAIO_INITIAL_WINDOW`)
 * and converts them to camelCase key-value pairs.
 *
 * This is a generic collection utility — it returns **all** matching env
 * vars, and the desktop host mains currently forward the full record as
 * `createWindow(...).params`.
 * @returns Record of camelCase keys to string values.
 */
export function resolveInitialCustomData(): Record<string, string> {
  const prefix = 'MAKAIO_INITIAL_';
  const skip = new Set(['MAKAIO_INITIAL_WINDOW']);
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix) && !skip.has(key) && value !== undefined) {
      const suffix = key.slice(prefix.length);
      if (!suffix) continue;
      const field = suffix.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      result[field] = value;
    }
  }
  return result;
}
