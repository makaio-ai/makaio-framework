import { expect, vi } from 'vitest';
import { createMakaioContext } from '@makaio/core';
import { createBusInstance } from '@makaio/bus-core';
import { SubagentConfigSchema, SubagentError, type SubagentConfig } from '@makaio/contracts';
import type { ToolExecutionContext, BusLike } from '@makaio/tools-core';

/**
 * Helper to create SubagentConfig with defaults applied.
 * @param task - Task description
 * @returns Parsed config with defaults
 */
export function config(task: string): SubagentConfig {
  return SubagentConfigSchema.parse({ task });
}

/**
 * Helper to create spawn input with defaults applied.
 * @param overrides - Partial spawn input
 * @returns Parsed spawn input with defaults
 */
export function spawnInput(overrides: { task: string } & Partial<SubagentConfig>): SubagentConfig {
  return SubagentConfigSchema.parse(overrides);
}

/**
 * Helper to verify SubagentError with specific code.
 * @param fn - Function expected to throw
 * @param expectedCode - Expected error code
 */
export function expectSubagentError(fn: () => void, expectedCode: string): void {
  try {
    fn();
    expect.fail('Expected function to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(SubagentError);
    expect((err as SubagentError).code).toBe(expectedCode);
  }
}

/**
 * Type for a mock request handler that receives the payload and returns a response.
 */
type MockRequestHandler<Req = unknown, Res = unknown> = (payload: Req) => Res | Promise<Res>;

/**
 * Creates a mock bus for testing subagent tools.
 *
 * Uses vitest spies to intercept request calls without mutating the bus instance.
 * Handlers are registered by subject string for convenience.
 * @returns Object containing the bus and configuration methods
 */
export function createMockBus(): {
  bus: BusLike;
  /** Configure a handler for a specific subject string */
  onRequest: (subjectString: string, handler: MockRequestHandler) => void;
  /** Reset all handlers (call in beforeEach or afterEach) */
  reset: () => void;
} {
  const bus = createBusInstance();
  const requestHandlers = new Map<string, MockRequestHandler>();

  // Spy on the request method to intercept calls
  const requestSpy = vi.spyOn(bus, 'request').mockImplementation(async (subject, payload) => {
    const subjectString = (subject as { subject: string }).subject;
    const handler = requestHandlers.get(subjectString);
    if (handler) {
      const result = handler(payload);
      return result instanceof Promise ? await result : result;
    }
    throw new Error(`No mock handler registered for subject: ${subjectString}`);
  });

  // Spy on requestOptional to intercept optional-service calls.
  // Returns { handled: true, data } when a handler is registered, { handled: false } otherwise.
  const requestOptionalSpy = vi.spyOn(bus, 'requestOptional').mockImplementation(async (subject, payload) => {
    const subjectString = (subject as { subject: string }).subject;
    const handler = requestHandlers.get(subjectString);
    if (!handler) {
      return { handled: false };
    }
    const result = handler(payload);
    const data = result instanceof Promise ? await result : result;
    return { handled: true, data };
  });

  return {
    bus,
    onRequest: (subjectString: string, handler: MockRequestHandler) => {
      requestHandlers.set(subjectString, handler);
    },
    reset: () => {
      requestHandlers.clear();
      requestSpy.mockClear();
      requestOptionalSpy.mockClear();
    },
  };
}

/**
 * Creates a test execution context for parent tools.
 * @param options - Context options with bus, optional sessionId and subagentDepth
 * @returns Tool execution context
 */
export function createParentContext(options: {
  bus: BusLike;
  sessionId?: string;
  subagentDepth?: number;
}): ToolExecutionContext {
  return {
    ...createMakaioContext({ cwd: '/test' }),
    sessionId: options.sessionId ?? 'parent-session-1',
    subagentDepth: options.subagentDepth ?? 0,
    bus: options.bus,
  };
}

/**
 * Creates a test execution context for child tools.
 * @param options - Context options with bus, subagentId, optional sessionId and subagentDepth
 * @returns Tool execution context
 */
export function createChildContext(options: {
  bus: BusLike;
  sessionId?: string;
  subagentId: string;
  subagentDepth?: number;
}): ToolExecutionContext {
  return {
    ...createMakaioContext({ cwd: '/test' }),
    sessionId: options.sessionId ?? 'child-session-1',
    subagentId: options.subagentId,
    subagentDepth: options.subagentDepth ?? 1,
    bus: options.bus,
  };
}
