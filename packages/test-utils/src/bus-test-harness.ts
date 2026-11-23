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
 * expect(request).toHaveBeenCalledWith(expect.anything(), expect.anything(), { key: 'foo' });
 * ```
 */

import { expect, vi, type Mock } from 'vitest';
import {
  createBusInstance,
  getFullSubjectForSubjectDefinition,
  type IMakaioBus,
  type RegisteredSubjectSchema,
  type ScopedBus,
} from '@makaio/bus-core';
import { busContextOf } from '@makaio/bus-core/kernel-api';

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
  own: Mock;
  registerNamespace: Mock;
  registerNamespaces: Mock;
  getSchema: Mock;
  extendSubject: Mock;
  registerTransport: Mock;
  unregisterTransport: Mock;
  disconnect: Mock;
  reconnect: Mock;
  connect: Mock;
  readonly ready: Promise<void>;
  observeMessages: Mock;
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
  /** Mock for bus.own() - returns a real minted call context */
  own: Mock;
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
 * Build an `own` mock that returns real minted call contexts.
 *
 * Contexts come from the public `createBusInstance().own(purpose)` path, so
 * `toHaveBeenCalledWith(expect.anything(), ...)` on `request` and `emit` finds
 * a defined `call` argument (`expect.anything()` does not match `undefined`).
 * @returns Mock `own` backed by a private real bus instance
 */
function createOwnMock(): Mock<IMakaioBus['own']> {
  const owner = createBusInstance();
  return vi.fn((purpose: Parameters<IMakaioBus['own']>[0]) => owner.own(purpose));
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
  const own = createOwnMock();
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
    own,
    registerNamespace: vi.fn(),
    registerNamespaces: vi.fn(),
    getSchema: vi.fn(),
    extendSubject: vi.fn().mockImplementation((subject: unknown) => subject),
    registerTransport: vi.fn().mockImplementation(() => createTransportRegistrationMock()),
    unregisterTransport: vi.fn(),
    disconnect: transportMethods.disconnect,
    reconnect: vi.fn().mockResolvedValue(undefined),
    connect: transportMethods.connect,
    observeMessages: vi.fn().mockReturnValue(() => undefined),
    get ready(): Promise<void> {
      return transportMethods.currentReady;
    },
  };

  return { bus: bus as IMakaioBus, request, emit, on, requestOptional, withFilter, own, setReady };
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
  /** Mock for bus.registerNamespace() */
  registerNamespace: Mock;
  /** Mock for bus.registerNamespaces() */
  registerNamespaces: Mock;
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
  const own = createOwnMock();
  const registerNamespace = vi.fn();
  const registerNamespaces = vi.fn();
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
    own,
    registerNamespace,
    registerNamespaces,
    getSchema,
    extendSubject: vi.fn().mockImplementation((subject: unknown) => subject),
    registerTransport: vi.fn().mockImplementation(() => createTransportRegistrationMock()),
    unregisterTransport: vi.fn(),
    disconnect: transportMethods.disconnect,
    reconnect: vi.fn().mockResolvedValue(undefined),
    connect: transportMethods.connect,
    observeMessages: vi.fn().mockReturnValue(() => undefined),
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
    own,
    setReady,
    once,
    scoped,
    __onAny,
    registerNamespace,
    registerNamespaces,
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
  } satisfies ScopedMockBusShape as ScopedBus<string>;

  return { bus, request, emit, on, once, withFilter };
}

/**
 * Creates a real bus instance for integration tests.
 *
 * Use this when you need schema validation and real handler execution. The
 * instance is bound to the host party of its own fresh context; send with
 * `bus.own('root')` as the call context.
 * @returns Real IMakaioBus instance
 */
export function createTestBusInstance(): IMakaioBus {
  return createBusInstance();
}

/**
 * Subject definition shape accepted by {@link countSubjectHandlers}.
 *
 * Derived from the real `getFullSubjectForSubjectDefinition` signature so any
 * concrete namespace subject is accepted without an extra type dependency.
 */
export type BusSubjectRef = Parameters<typeof getFullSubjectForSubjectDefinition>[0];

/**
 * Count the handlers currently registered for one subject on a bus instance.
 *
 * Reads the bus context's request- and event-handler registries directly so
 * registration tests can assert real subscription state (register adds exactly
 * one handler per subject; cleanup removes it) instead of only checking that a
 * register function returned a cleanup callback.
 * @param bus - Bus instance whose context to inspect.
 * @param subject - Subject definition to count handlers for.
 * @returns Number of request plus event handlers registered for the subject.
 */
export function countSubjectHandlers(bus: IMakaioBus, subject: BusSubjectRef): number {
  const fullSubject = getFullSubjectForSubjectDefinition(subject);
  const context = busContextOf(bus);
  return (
    (context.requestHandlers.get(fullSubject)?.length ?? 0) + (context.eventHandlers.get(fullSubject)?.length ?? 0)
  );
}

/**
 * List the subjects registered in a bus instance's namespace registry.
 *
 * Reads the bus context's namespace registry directly so tests and tooling can
 * inspect the real registered subject metadata of a bus.
 * @param bus - Bus whose namespace registry is read
 * @returns Registered subject metadata of that bus
 */
export function listRegisteredSubjects(bus: IMakaioBus): RegisteredSubjectSchema[] {
  return busContextOf(bus).namespaceRegistry.listRegisteredSubjects();
}

/**
 * Assert the register-to-cleanup lifecycle of bus handler registration.
 *
 * Runs `register`, asserts every given subject gained exactly one handler on
 * the bus, then invokes the returned cleanup and asserts every subject
 * dropped back to zero handlers. Use with an isolated bus from
 * {@link createTestBusInstance} so the assertions observe only the
 * registration under test.
 * @param bus - Bus instance the registration subscribes on.
 * @param subjects - Subjects the registration must cover exactly once each.
 * @param register - Registration function under test, returning its cleanup.
 */
export function expectSubjectHandlerLifecycle(
  bus: IMakaioBus,
  subjects: readonly BusSubjectRef[],
  register: () => () => void,
): void {
  const cleanup = register();
  for (const subject of subjects) {
    expect(countSubjectHandlers(bus, subject), `expected one handler for '${String(subject.subject)}'`).toBe(1);
  }

  cleanup();
  for (const subject of subjects) {
    expect(countSubjectHandlers(bus, subject), `expected cleanup to unsubscribe '${String(subject.subject)}'`).toBe(0);
  }
}
