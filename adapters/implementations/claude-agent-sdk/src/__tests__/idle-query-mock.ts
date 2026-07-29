import { vi } from 'vitest';

/**
 * Create an idle SDK query test double whose iterator remains open until close.
 * @returns Minimal query surface used by initialization-only connector tests.
 */
export function createIdleQueryMock() {
  let finishIterator: (() => void) | undefined;
  let closed = false;
  return {
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => {
      closed = true;
      finishIterator?.();
    }),
    setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
    setMaxThinkingTokens: vi.fn(async () => undefined),
    async *[Symbol.asyncIterator]() {
      if (closed) return;
      await new Promise<void>((resolve) => {
        finishIterator = resolve;
      });
    },
  };
}
