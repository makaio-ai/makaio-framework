import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the OpenCode fixture directory for integration tests that exercise
 * the real OpenCode import pipeline.
 * @returns Absolute path to the OpenCode fixture directory.
 */
export function getOpenCodeFixtureDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../__tests__/fixtures');
}
