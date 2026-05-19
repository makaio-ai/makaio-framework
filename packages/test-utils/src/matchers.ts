/**
 * Custom bun:test matchers that fill gaps in the built-in matcher set.
 *
 * Side-effect-only import: registers matchers via `expect.extend` at module
 * evaluation time. Intended as a bunfig.toml preload so all test files get the
 * matchers automatically.
 */

import { expect } from 'bun:test';

expect.extend({
  /**
   * Asserts a mock function was called exactly once.
   * @param received - The mock function to check.
   * @returns Match result with pass flag and failure message.
   */
  toHaveBeenCalledOnce(received: unknown) {
    const mockObj = received as { mock: { calls: unknown[] } };
    const count = mockObj.mock.calls.length;
    return {
      pass: count === 1,
      message: () => `expected mock to have been called once, but it was called ${count} time${count === 1 ? '' : 's'}`,
    };
  },
});

declare module 'bun:test' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- must match bun:test's Matchers<T> declaration
  interface Matchers<T> {
    /** Asserts the mock was called exactly once. */
    toHaveBeenCalledOnce(): void;
  }
}
