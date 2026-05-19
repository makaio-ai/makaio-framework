/**
 * Environment variable stubbing for bun:test.
 *
 * Provides the same contract as vitest's `vi.stubEnv` / `vi.unstubAllEnvs`:
 * set env vars for the duration of a test, then restore originals in afterEach.
 */

const originals = new Map<string, string | undefined>();

/**
 * Stub an environment variable for the current test.
 *
 * Saves the original value on first call for a given key (recording `undefined`
 * when the key was absent). Call {@link unstubAllEnvs} in `afterEach` to
 * restore all originals.
 * @param key - Environment variable name.
 * @param value - Value to set, or `undefined` to delete the key.
 */
export function stubEnv(key: string, value: string | undefined): void {
  if (!originals.has(key)) {
    originals.set(key, process.env[key]);
  }

  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/**
 * Restore all environment variables stubbed via {@link stubEnv}.
 *
 * Typically called in `afterEach`. Keys that were absent before stubbing are
 * deleted; keys that had a value are restored to their original value.
 */
export function unstubAllEnvs(): void {
  for (const [key, original] of originals) {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  originals.clear();
}
