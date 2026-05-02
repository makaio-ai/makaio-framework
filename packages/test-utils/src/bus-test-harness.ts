/**
 * Bus test harness for type-safe mocking.
 *
 * Provides mock bus instances that satisfy type constraints without
 * unsafe casts scattered across test files.
 * @example
 * ```ts
 * import { createMockBus } from '@makaio/test-utils';
 *
 * const { bus, request } = createMockBus();
 * request.mockResolvedValue({ value: [] });
 *
 * // Pass bus to component/service under test
 * const manager = new WorkspaceStateManager(bus);
 *
 * // Assert calls
 * expect(request).toHaveBeenCalledWith(expect.anything(), { key: 'foo' });
 * ```
 */

import { vi, type Mock } from 'vitest';
import { createBusInstance, type IMakaioBus, type ScopedBus } from '@makaio/bus-core';

/**
 * Full structural shape required by `IMakaioBus` for test doubles.
 *
 * All members are typed as `Mock` so TypeScript validates the object literal
 * against this interface before the single-hop cast to `IMakaioBus`. Less-used
 * methods are stubs that callers do not need to assert on; only the commonly
 * exercised subset is surfaced in each `Mock*BusResult` return type.
 */
interface MockBusShape {
  namespace: string;
  request: Mock;
  emit: Mock;
  on: Mock;
  once: Mock;
  intercept: Mock;
  requestOptional: Mock;
  withFilter: Mock;
  broadcast: Mock;
  scoped: Mock;
  __onAny: Mock;
  getContext: Mock;
  registerNamespace: Mock;
  getSchema: Mock;
  extendSubject: Mock;
  registerTransport: Mock;
  unregisterTransport: Mock;
  disconnect: Mock;
  reconnect: Mock;
  connect: Mock;
  readonly ready: Promise<void>;
}

/**
 * Full structural shape required by `ScopedBus<string>` for test doubles.
 */
interface ScopedMockBusShape {
  namespace: string;
  request: Mock;
  emit: Mock;
  on: Mock;
  once: Mock;
  intercept: Mock;
  requestOptional: Mock;
  withFilter: Mock;
  getContext: Mock;
}

/**
 * Mock bus return type with exposed mock functions for assertions.
 */
export interface MockBusResult {
  /** Type-safe IMakaioBus instance */
  bus: IMakaioBus;
  /** Mock for bus.request() - use for assertions and mockResolvedValue */
  request: Mock;
  /** Mock for bus.emit() */
  emit: Mock;
  /** Mock for bus.on() - returns cleanup function */
  on: Mock;
  /** Mock for bus.requestOptional() */
  requestOptional: Mock;
  /** Mock for bus.withFilter() */
  withFilter: Mock;
  /** Resolves or replaces the backing promise returned by the live bus.ready getter. */
  setReady: (ready?: Promise<void>) => void;
}

interface MockTransportRegistration {
  unregister: Mock;
  ready: Promise<void>;
}

interface MockTransportMethods {
  connect: Mock;
  disconnect: Mock;
  readonly currentReady: Promise<void>;
  resolveReady: () => void;
  replaceReady: (ready: Promise<void>) => void;
}

interface DeferredReady {
  promise: Promise<void>;
  resolve: () => void;
}

/**
 * Create a deferred ready handle for mock transport lifecycle control.
 * @returns Deferred promise plus its resolver
 */
function createDeferredReady(): DeferredReady {
  let resolved = false;
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      promiseResolve();
    };
  });
  return { promise, resolve };
}

/**
 * Create a transport registration mock matching the real bus contract.
 * @returns Mock unregister handle plus an already-ready promise
 */
function createTransportRegistrationMock(): MockTransportRegistration {
  return {
    unregister: vi.fn(),
    ready: Promise.resolve(),
  };
}

/**
 * Build transport lifecycle mocks that expose a live ready getter matching the
 * real bus contract.
 * @returns Shared transport method mocks and backing ready promise.
 */
function createMockTransportMethods(): MockTransportMethods {
  let readyState = createDeferredReady();
  return {
    connect: vi.fn().mockImplementation(async () => readyState.promise),
    disconnect: vi.fn().mockImplementation(() => {
      readyState.resolve();
      readyState = createDeferredReady();
    }),
    get currentReady() {
      return readyState.promise;
    },
    resolveReady: () => {
      readyState.resolve();
    },
    replaceReady: (ready) => {
      readyState.resolve();
      // External promise owns this session's resolution; the no-op resolver
      // ensures later resolveReady()/setReady() calls cannot override it.
      readyState = { promise: ready, resolve: () => undefined };
    },
  };
}

/**
 * Build a `setReady` shim that delegates to the transport mock's lifecycle
 * controls.
 *
 * Calling without an argument resolves the current deferred promise (bus
 * transitions to ready). Passing a promise replaces the backing state so the
 * live `bus.ready` getter returns the new promise on next access.
 * @param transportMethods - The transport mock to delegate to
 * @returns A `setReady` function matching `MockBusResult.setReady`
 */
function createSetReady(transportMethods: MockTransportMethods): (ready?: Promise<void>) => void {
  return (ready?: Promise<void>) => {
    if (ready !== undefined) {
      transportMethods.replaceReady(ready);
      return;
    }
    transportMethods.resolveReady();
  };
}

/**
 * Creates a mock bus for unit tests.
 *
 * Returns a partial mock with the most commonly used methods.
 * Use this when you need to verify bus method calls without triggering real handlers.
 * @returns Object containing typed bus and exposed mock functions
 */
export function createMockBus(): MockBusResult {
  const request = vi.fn();
  const emit = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn().mockReturnValue(() => {});
  const requestOptional = vi.fn();
  const withFilter = vi.fn().mockReturnThis();
  const transportMethods = createMockTransportMethods();
  const setReady = createSetReady(transportMethods);

  const bus: MockBusShape = {
    namespace: 'mock',
    request,
    emit,
    on,
    once: vi.fn(),
    intercept: vi.fn(),
    requestOptional,
    withFilter,
    broadcast: vi.fn(),
    scoped: vi.fn(),
    __onAny: vi.fn(),
    getContext: vi.fn(),
    registerNamespace: vi.fn(),
    getSchema: vi.fn(),
    extendSubject: vi.fn().mockImplementation((subject: unknown) => subject),
    registerTransport: vi.fn().mockImplementation(() => createTransportRegistrationMock()),
    unregisterTransport: vi.fn(),
    disconnect: transportMethods.disconnect,
    reconnect: vi.fn().mockResolvedValue(undefined),
    connect: transportMethods.connect,
    get ready(): Promise<void> {
      return transportMethods.currentReady;
    },
  };

  return { bus: bus as IMakaioBus, request, emit, on, requestOptional, withFilter, setReady };
}

/**
 * Mock global bus return type with additional methods for adapter tests.
 */
export interface MockGlobalBusResult extends MockBusResult {
  /** Mock for bus.once() */
  once: Mock;
  /** Mock for bus.scoped() */
  scoped: Mock;
  /** Mock for bus.__onAny() */
  __onAny: Mock;
  /** Mock for bus.getContext() */
  getContext: Mock;
  /** Mock for bus.registerNamespace() */
  registerNamespace: Mock;
  /** Mock for bus.getSchema() */
  getSchema: Mock;
}

/**
 * Creates a full mock global bus for adapter/agent tests.
 *
 * Includes additional methods like scoped(), __onAny(), registerNamespace().
 * Use this when testing code that uses the full IMakaioBus interface.
 * @param namespace - Optional namespace identifier (default: 'global')
 * @returns Object containing typed bus and exposed mock functions
 */
export function createMockGlobalBus(namespace = 'global'): MockGlobalBusResult {
  const request = vi.fn().mockResolvedValue({});
  const emit = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn().mockReturnValue(() => {});
  const requestOptional = vi.fn().mockResolvedValue({ ok: true, value: {} });
  const withFilter = vi.fn().mockReturnThis();
  const once = vi.fn().mockResolvedValue({});
  const scoped = vi.fn();
  const __onAny = vi.fn().mockReturnValue(() => {});
  const getContext = vi.fn();
  const registerNamespace = vi.fn();
  const getSchema = vi.fn();
  const transportMethods = createMockTransportMethods();
  const setReady = createSetReady(transportMethods);

  const bus: MockBusShape = {
    namespace,
    request,
    emit,
    on,
    once,
    intercept: vi.fn(),
    requestOptional,
    withFilter,
    broadcast: vi.fn(),
    scoped,
    __onAny,
    getContext,
    registerNamespace,
    getSchema,
    extendSubject: vi.fn().mockImplementation((subject: unknown) => subject),
    registerTransport: vi.fn().mockImplementation(() => createTransportRegistrationMock()),
    unregisterTransport: vi.fn(),
    disconnect: transportMethods.disconnect,
    reconnect: vi.fn().mockResolvedValue(undefined),
    connect: transportMethods.connect,
    get ready(): Promise<void> {
      return transportMethods.currentReady;
    },
  };

  return {
    bus: bus as IMakaioBus,
    request,
    emit,
    on,
    requestOptional,
    withFilter,
    setReady,
    once,
    scoped,
    __onAny,
    getContext,
    registerNamespace,
    getSchema,
  };
}

/**
 * Mock scoped bus return type for adapter-internal tests.
 */
export interface MockScopedBusResult {
  /** Type-safe ScopedBus instance */
  bus: ScopedBus<string>;
  /** Mock for bus.request() */
  request: Mock;
  /** Mock for bus.emit() */
  emit: Mock;
  /** Mock for bus.on() */
  on: Mock;
  /** Mock for bus.once() */
  once: Mock;
  /** Mock for bus.withFilter() */
  withFilter: Mock;
}

/**
 * Creates a mock scoped bus for adapter-internal tests.
 *
 * Use this when testing code that receives a ScopedBus (e.g., AIAgent internals).
 * @param namespace - Namespace identifier (default: 'test')
 * @returns Object containing typed scoped bus and exposed mock functions
 */
export function createMockScopedBus(namespace = 'test'): MockScopedBusResult {
  const request = vi.fn().mockResolvedValue({});
  const emit = vi.fn().mockResolvedValue(undefined);
  const on = vi.fn().mockReturnValue(() => {});
  const once = vi.fn().mockResolvedValue({});
  const withFilter = vi.fn().mockReturnThis();

  const bus = {
    namespace,
    request,
    emit,
    on,
    once,
    intercept: vi.fn(),
    requestOptional: vi.fn(),
    withFilter,
    getContext: vi.fn(),
  } satisfies ScopedMockBusShape as ScopedBus<string>;

  return { bus, request, emit, on, once, withFilter };
}

/**
 * Creates a real bus instance for integration tests.
 *
 * Use this when you need schema validation and real handler execution.
 * @returns Real IMakaioBus instance
 */
export function createTestBusInstance(): IMakaioBus {
  return createBusInstance();
}
