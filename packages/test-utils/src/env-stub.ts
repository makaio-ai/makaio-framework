/**
 * Lightweight process.env stubbing for tests. Works in both vitest and bun:test.
 */

const originals = new Map<string, string | undefined>();

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
