import { vi } from 'vitest';
import type { SDKMessage } from '@makaio/client-claude-code';

/**
 * Minimal transport stub type matching the parts used by the harness.
 * Callers provide a stub created by `createTransportStub()` inside `vi.hoisted`.
 */
export interface TransportStub {
  onMessage: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/**
 * Return type of {@link makeTransportHarness}.
 */
export interface TransportHarness {
  /** The raw transport stub — pass as the `createStdioTransport` return value in `vi.mock`. */
  transport: TransportStub;
  /**
   * Emit an SDK message into the session's consumption loop.
   * Throws when the transport's onMessage callback was not yet registered.
   * @param message - The SDK message to deliver
   */
  emitMessage(message: SDKMessage): void;
  /**
   * Emit a transport error into the session's error handler.
   * Throws when the transport's onError callback was not yet registered.
   * @param error - The error to deliver
   */
  emitError(error: Error): void;
  /**
   * Clear captured callbacks and reset the mock call counts.
   * Call from `beforeEach` to isolate each test.
   */
  reset(): void;
}

/**
 * Wire a transport stub created inside `vi.hoisted` into a full harness that
 * tracks the callbacks registered by the session and exposes `emitMessage`,
 * `emitError`, and `reset` helpers.
 *
 * This function must be called **after** the `vi.mock` and import statements,
 * i.e. at module level inside the test file but outside any `vi.hoisted` block.
 * @param stub - A transport stub produced by `createTransportStub()` in `vi.hoisted`
 * @returns A harness with emit helpers and a reset function
 */
export function makeTransportHarness(stub: TransportStub): TransportHarness {
  type MessageCallback = (message: SDKMessage) => void;
  type ErrorCallback = (error: Error) => void;

  let messageCallback: MessageCallback | undefined;
  let errorCallback: ErrorCallback | undefined;

  stub.onMessage.mockImplementation((callback: MessageCallback) => {
    messageCallback = callback;
  });
  stub.onError.mockImplementation((callback: ErrorCallback) => {
    errorCallback = callback;
  });

  return {
    transport: stub,
    emitMessage(message: SDKMessage): void {
      if (!messageCallback) {
        throw new Error('Transport message callback was not registered');
      }
      messageCallback(message);
    },
    emitError(error: Error): void {
      if (!errorCallback) {
        throw new Error('Transport error callback was not registered');
      }
      errorCallback(error);
    },
    reset(): void {
      messageCallback = undefined;
      errorCallback = undefined;
      vi.mocked(stub.onMessage).mockClear();
      vi.mocked(stub.onError).mockClear();
      vi.mocked(stub.close).mockClear();
    },
  };
}
