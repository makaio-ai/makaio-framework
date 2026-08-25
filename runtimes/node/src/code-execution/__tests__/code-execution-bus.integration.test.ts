import { randomUUID } from 'node:crypto';
import { threadId as hostThreadId } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createBusInstance,
  type BusBroadcastMessage,
  type BusEventMessage,
  type BusMessage,
  type BusRequestMessage,
  type BusTransport,
  type IMakaioBus,
} from '@makaio/bus-core';
import {
  CODE_EXECUTION_CAPABILITY_ID,
  CapabilitySubjects,
  CodeExecutionSubjects,
  FrameworkContractNamespaces,
  registerCodeExecutionProvider,
  unregisterCodeExecutionProvider,
  type CodeExecutionOutcome,
  type CodeExecutionRequest,
  type JsonValue,
} from '@makaio/contracts';
import { CapabilityService } from '@makaio/services-core/capability';
import { CodeExecutionService } from '@makaio/services-core/code-execution';
import { createBidirectionalTransportPair } from '../../../../../core/bus-core/src/__tests__/helpers/transport-fixtures.js';
import { PiscinaCodeExecutionProvider } from '../piscina-code-execution-provider.js';
import {
  createCodeExecutionScratch,
  NEVER_RETURNING_PROGRAM,
  waitForPath,
  type CodeExecutionScratch,
} from './helpers/execution-fixtures.js';

// ─────────────────────────────────────────────────────────────
// Module overview
// ─────────────────────────────────────────────────────────────

// End-to-end coverage of the complete opt-in CodeExecution path over the real
// bus: the contract namespaces registered on an isolated bus instance, the real
// capability registry, the real routing service, and the real Piscina provider.
// Every invocation goes through `bus.request(CodeExecutionSubjects.execute, …)`
// and every program is real TypeScript the provider transpiles and runs on a
// worker thread. Nothing in this file is mocked.
//
// Because the `code-execution` namespace is registered on the bus under the
// default strict validation mode, the bus itself parses each request against
// `CodeExecutionRequestSchema` and each response against
// `CodeExecutionOutcomeSchema` before the caller sees it.

/** Per-test wall-clock budget. */
const TEST_TIMEOUT_MS = 30_000;

/**
 * Execution budget every request in this file declares.
 *
 * Deliberately larger than {@link TEST_TIMEOUT_MS}: nothing here is meant to be
 * settled by the request's own budget, so a run that reached it surfaces as a
 * test timeout instead of passing quietly as a `timed_out` outcome.
 */
const REQUEST_BUDGET_MS = 120_000;

/**
 * How long to wait for an executing program to announce that it started.
 *
 * Deliberately well below {@link TEST_TIMEOUT_MS}: a program that never starts
 * must fail with the waiter's own diagnostic and still leave the case room to
 * tear its host down, rather than being cut off by the outer timeout.
 */
const PROGRAM_START_TIMEOUT_MS = TEST_TIMEOUT_MS / 2;

/**
 * Absolute deadline the caller propagates in the deadline case, in milliseconds.
 *
 * Far below {@link REQUEST_BUDGET_MS}, so the inherited deadline is the only
 * thing that can settle the invocation — and far above the time a warm pool
 * needs to start a program, so it cannot fire before the worker it is meant to
 * end is occupied. That second margin is why the case warms the pool first: a
 * cold pool spends most of a second spawning its thread, which is the same
 * order of magnitude as the deadline itself.
 */
const PROPAGATED_DEADLINE_MS = 2_000;

/** Priority that puts an observing handler ahead of the routing service. */
const OBSERVER_PRIORITY = 100;

/**
 * Bus request options that leave the request's own budget in sole control.
 *
 * `timeout: 0` removes the bus deadline, so no absolute deadline is propagated
 * and the invocation is settled by the request, the caller, or the provider.
 */
const NO_BUS_DEADLINE = { timeout: 0 } as const;

/**
 * Multi-file TypeScript program that reports which thread it ran on.
 *
 * The relative import makes this a real module graph rather than a single
 * source string, and the thread comparison is what shows the program was
 * transferred to a worker instead of being evaluated in the calling thread.
 */
const THREAD_REPORTING_PROGRAM: Readonly<Record<string, string>> = {
  'entry.ts': [
    "import { isMainThread, threadId } from 'node:worker_threads';",
    "import { shout } from './lib/format.js';",
    'interface Input { readonly name: string; readonly hostThreadId: number }',
    'interface Report {',
    '  readonly message: string;',
    '  readonly offHostThread: boolean;',
    '  readonly onMainThread: boolean;',
    '}',
    'export const handler = async (input: Input): Promise<Report> => ({',
    '  message: shout(input.name),',
    '  offHostThread: threadId !== input.hostThreadId,',
    '  onMainThread: isMainThread,',
    '});',
  ].join('\n'),
  'lib/format.ts': 'export const shout = (value: string): string => `${value.toUpperCase()}!`;',
};

/** Single-file program whose handler returns a constant immediately. */
const ANSWERING_PROGRAM: Readonly<Record<string, string>> = {
  'entry.ts': 'export const handler = (): number => 7;',
};

/** One step of the host's ordered teardown. */
type TeardownStep = () => Promise<void>;

/** One peer's contribution to an aggregated broadcast result. */
type BroadcastResult = { nodeId: string; payload: unknown };

/** A handler-chain observation of the outcome the router settled on. */
interface SettlementObserver {
  /**
   * Resolves with the terminal outcome of the first invocation to settle.
   *
   * Single-shot on purpose: the observing handler stays attached for later
   * invocations in the same case, and those must not overwrite the settlement
   * the case is about.
   */
  readonly settled: Promise<CodeExecutionOutcome | undefined>;
  /** Remove the observing handler. */
  stop(): void;
}

/**
 * Build a schema-valid request for a virtual program.
 * @param files - Virtual module set keyed by canonical virtual path.
 * @param input - JSON-safe argument handed to the invoked export.
 * @returns A prepared execution request the `code-execution.execute` subject accepts.
 */
function createRequest(files: Readonly<Record<string, string>>, input: JsonValue = null): CodeExecutionRequest {
  return {
    invocationId: randomUUID(),
    program: { files, entryFile: 'entry.ts', exportName: 'handler' },
    arguments: input,
    timeoutMs: REQUEST_BUDGET_MS,
  };
}

/**
 * Observe the terminal outcome the router settled, independently of the caller.
 *
 * A local caller that aborts — or whose propagated deadline elapses — observes
 * a rejected `bus.request`, so the typed outcome has to be read from the
 * handler chain rather than from the caller's promise. The observer runs ahead
 * of the routing service and reads `ctx.result` after delegating, which is how
 * a host inspects a settlement it did not itself await.
 * @param bus - Bus carrying the `code-execution.execute` subject.
 * @returns The pending settlement and the observing handler's unsubscribe.
 */
function observeSettlement(bus: IMakaioBus): SettlementObserver {
  let resolveSettled: (outcome: CodeExecutionOutcome | undefined) => void = () => undefined;
  const settled = new Promise<CodeExecutionOutcome | undefined>((resolve) => {
    resolveSettled = resolve;
  });
  const stop = bus.on(
    CodeExecutionSubjects.execute,
    async (ctx) => {
      await ctx.next();
      resolveSettled(ctx.result);
    },
    { priority: OBSERVER_PRIORITY },
  );
  return { settled, stop };
}

/**
 * Transport that records the full subject of every message the bus relays.
 *
 * A real transport is the only honest way to ask "would this have left the
 * process?": routing is decided inside the bus, so a helper that inspected the
 * emit options instead would only assert its own argument.
 */
class RecordingTransport implements BusTransport {
  /** Registry key this transport is attached under. */
  public readonly name = 'recording';
  /** Full subjects relayed to the peer, in send order. */
  public readonly relayed: string[] = [];

  /**
   * Relay a request message.
   * @param message - Request message the bus decided to relay.
   * @param timeout - Correlation timeout in milliseconds.
   * @returns Never resolves; this transport has no peer to answer a request.
   */
  public send(message: BusRequestMessage, timeout?: number): Promise<unknown>;
  /**
   * Relay an event message.
   * @param message - Event message the bus decided to relay.
   * @param timeout - Correlation timeout in milliseconds.
   * @returns Delivery status.
   */
  public send(message: BusEventMessage, timeout?: number): Promise<boolean>;
  /**
   * Relay a broadcast message.
   * @param message - Broadcast message the bus decided to relay.
   * @param timeout - Correlation timeout in milliseconds.
   * @returns The peer contributions to the aggregation, of which there are none.
   */
  public send(message: BusBroadcastMessage, timeout?: number): Promise<BroadcastResult[]>;
  /**
   * Record a relayed message instead of putting it on a wire.
   * @param message - Message the bus decided to relay.
   * @param timeout - Correlation timeout in milliseconds, unused here.
   * @returns The result shape the message type's contract prescribes.
   * @throws {@link Error} When a request is relayed, which no case here expects.
   */
  public send(message: BusMessage, timeout?: number): Promise<unknown | boolean | BroadcastResult[]> {
    void timeout;
    // Transport-level handshake frames carry no subject and say nothing about
    // routing, so they must not show up as relayed traffic.
    if ('subject' in message && 'namespace' in message) {
      this.relayed.push(`${message.namespace}.${message.subject}`);
    }
    // A broadcast resolves to the per-node contributions the relay spreads into
    // its aggregate, never to a bare status; an empty array is the honest answer
    // from a transport with no peer behind it. Fabricating a request response
    // would be the one mocked value in this file, so a relayed request fails
    // loudly instead — nothing here has a remote handler to route one to.
    if (message.type === 'broadcast') return Promise.resolve([]);
    if (message.type === 'request') {
      return Promise.reject(new Error(`RecordingTransport has no peer to answer '${message.subject}'.`));
    }
    return Promise.resolve(true);
  }

  /**
   * Accept an inbound handler this transport never invokes.
   * @returns Unsubscribe function.
   */
  public onReceive(): () => void {
    return () => undefined;
  }

  /** @returns Resolved promise; there is nothing to connect. */
  public connect(): Promise<void> {
    return Promise.resolve();
  }

  /** @returns Resolved promise; there is nothing to disconnect. */
  public disconnect(): Promise<void> {
    return Promise.resolve();
  }

  /** @returns Resolved promise; every subject is accepted. */
  public subscribe(): Promise<void> {
    return Promise.resolve();
  }

  /** @returns Resolved promise; every subject is accepted. */
  public unsubscribe(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Run ordered teardown steps to completion, then report what failed.
 *
 * A failing step must not strand the ones behind it: an undisposed worker pool
 * would outlive the test file and a live registry would outlive the router that
 * was supposed to be torn down before it.
 * @param steps - Teardown steps, in the order a host must run them.
 * @throws {@link AggregateError} When any step failed, after all of them ran.
 */
async function runTeardown(steps: readonly TeardownStep[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'CodeExecution host teardown failed.');
}

describe('code-execution.execute over the real bus', () => {
  let scratch: CodeExecutionScratch;
  let bus: IMakaioBus;
  let capabilities: CapabilityService;
  let service: CodeExecutionService;
  let provider: PiscinaCodeExecutionProvider;

  /**
   * Run one invocation through the real bus subject.
   * @param files - Virtual module set to execute.
   * @param input - JSON-safe argument handed to the invoked export.
   * @returns The normalized terminal outcome the handler chain produced.
   */
  async function execute(
    files: Readonly<Record<string, string>>,
    input: JsonValue = null,
  ): Promise<CodeExecutionOutcome> {
    return bus.request(CodeExecutionSubjects.execute, createRequest(files, input), NO_BUS_DEADLINE);
  }

  /**
   * Shut the composed host down in the order a host must use.
   *
   * The registration is withdrawn before the router is destroyed, the provider
   * is only disposed once nothing can route to it any more, and the registry
   * outlives all three because it is where the withdrawal was recorded. The
   * teardown case below pins that order explicitly with assertions between the
   * steps; this helper is what every other case relies on, and re-running it
   * after that case is harmless because every step is idempotent.
   * @returns Promise that resolves once the host is fully torn down.
   */
  function shutdownHost(): Promise<void> {
    return runTeardown([
      () => unregisterCodeExecutionProvider(bus, provider.id),
      () => service.destroy(),
      () => provider.dispose(),
      () => capabilities.destroy(),
    ]);
  }

  beforeAll(async () => {
    scratch = await createCodeExecutionScratch();
  });

  afterAll(async () => {
    await scratch.dispose();
  });

  beforeEach(async () => {
    bus = createBusInstance();
    // A host registers the contract catalog, which is what makes the
    // `code-execution` subject routable and strictly validated on this bus.
    bus.registerNamespaces(FrameworkContractNamespaces);
    capabilities = new CapabilityService(bus);
    await capabilities.init();
    service = new CodeExecutionService(bus, capabilities);
    await service.init();
    // Composed but not registered: a host opts in explicitly, and the pool is
    // created lazily, so an unused provider spawns no thread.
    provider = new PiscinaCodeExecutionProvider({ maxConcurrency: 1, idleTimeoutMs: 500 });
  });

  afterEach(async () => {
    await shutdownHost();
    // Every terminal path must leave the redirected temporary base empty again.
    expect(await scratch.listProgramRoots()).toEqual([]);
  });

  it('publishes the registered provider through the capability registry', async () => {
    await registerCodeExecutionProvider(bus, provider);

    const listed = await bus.request(CapabilitySubjects.listProviders, {
      capabilityId: CODE_EXECUTION_CAPABILITY_ID,
    });

    expect(listed).toEqual({ providers: [{ id: provider.id, displayName: provider.displayName }] });
  });

  it('keeps provider registration off every connected transport', async () => {
    // `capability.register` is an ordinary subject, so an unqualified emit is
    // relayed to every connected peer — which would put the live provider, and
    // with it the environment values it was composed with, on the wire. The
    // control emission below is what makes this case discriminating: it proves
    // the transport is connected and the subject is relayable, so the two
    // silences that follow are the helpers' doing.
    const transport = new RecordingTransport();
    bus.registerTransport(transport);
    const { relayed } = transport;

    await bus.emit(CapabilitySubjects.register, { capabilityId: 'unrelated-capability', provider: { id: 'plain' } });
    expect(relayed).toEqual(['capability.register']);
    relayed.length = 0;

    await registerCodeExecutionProvider(bus, provider);

    expect(relayed).toEqual([]);
    // The registration still took effect — locally, which is the point.
    expect(await bus.request(CapabilitySubjects.listProviders, { capabilityId: CODE_EXECUTION_CAPABILITY_ID })).toEqual(
      { providers: [{ id: provider.id, displayName: provider.displayName }] },
    );

    await unregisterCodeExecutionProvider(bus, provider.id);

    expect(relayed).toEqual([]);
    expect(await bus.request(CapabilitySubjects.listProviders, { capabilityId: CODE_EXECUTION_CAPABILITY_ID })).toEqual(
      { providers: [] },
    );
  });

  it('keeps provider registration off every transport when the host holds a filtered bus', async () => {
    // The registration helpers accept any bus-like object, and a host that
    // narrowed its bus with `withFilter` hands them a wrapper rather than the
    // root bus. A wrapper that dropped the routing option would relay the live
    // provider — and the environment values it was composed with — after all,
    // so the invariant has to hold through every bus a host can plausibly own.
    const transport = new RecordingTransport();
    bus.registerTransport(transport);
    const { relayed } = transport;
    const filtered = bus.withFilter({ capabilityId: CODE_EXECUTION_CAPABILITY_ID });

    // Same control emission as above, through the wrapper this time: it proves
    // the wrapper reaches the transport, so the silence that follows is the
    // forwarded option's doing.
    await filtered.emit(CapabilitySubjects.register, {
      capabilityId: 'unrelated-capability',
      provider: { id: 'plain' },
    });
    expect(relayed).toEqual(['capability.register']);
    relayed.length = 0;

    await registerCodeExecutionProvider(filtered, provider);

    expect(relayed).toEqual([]);
    expect(await bus.request(CapabilitySubjects.listProviders, { capabilityId: CODE_EXECUTION_CAPABILITY_ID })).toEqual(
      { providers: [{ id: provider.id, displayName: provider.displayName }] },
    );

    await unregisterCodeExecutionProvider(filtered, provider.id);

    expect(relayed).toEqual([]);
    expect(await bus.request(CapabilitySubjects.listProviders, { capabilityId: CODE_EXECUTION_CAPABILITY_ID })).toEqual(
      { providers: [] },
    );
  });

  it(
    'executes a transferred multi-file TypeScript program on a worker thread',
    async () => {
      await registerCodeExecutionProvider(bus, provider);

      // The bus parsed this response against `CodeExecutionOutcomeSchema` in
      // strict mode before handing it back, so reaching this line at all is
      // the contract check; only the value itself is left to assert.
      const outcome = await execute(THREAD_REPORTING_PROGRAM, { name: 'hello', hostThreadId });

      expect(outcome).toEqual({
        status: 'completed',
        value: { message: 'HELLO!', offHostThread: true, onMainThread: false },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it('answers provider_unavailable while no provider is registered', async () => {
    expect(capabilities.getProviders(CODE_EXECUTION_CAPABILITY_ID)).toEqual([]);

    expect(await execute(ANSWERING_PROGRAM)).toEqual({
      status: 'failed',
      error: { code: 'provider_unavailable', message: expect.any(String) },
    });
  });

  it(
    'rejects an aborted caller, terminates the worker task, and stays usable',
    async () => {
      await registerCodeExecutionProvider(bus, provider);
      const startedPath = scratch.path('started');
      const observer = observeSettlement(bus);

      try {
        const caller = new AbortController();
        const pending = bus.request(
          CodeExecutionSubjects.execute,
          createRequest(NEVER_RETURNING_PROGRAM, { startedPath }),
          { ...NO_BUS_DEADLINE, signal: caller.signal },
        );
        await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);
        caller.abort(new Error('caller went away'));

        await expect(pending).rejects.toThrow();
        expect(await observer.settled).toEqual({
          status: 'cancelled',
          error: { code: 'cancelled', message: expect.any(String) },
        });

        // The pool has a single thread and the aborted program never returns on
        // its own, so a following invocation can only complete if the worker
        // that was running it was torn down.
        expect(await execute(ANSWERING_PROGRAM)).toEqual({ status: 'completed', value: 7 });
      } finally {
        observer.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'executes remotely, propagates the deadline, terminates the remote worker, and reuses its pool',
    async () => {
      const callerBus = createBusInstance();
      const providerBus = createBusInstance();
      callerBus.registerNamespaces(FrameworkContractNamespaces);
      providerBus.registerNamespaces(FrameworkContractNamespaces);
      const providerCapabilities = new CapabilityService(providerBus);
      await providerCapabilities.init();
      const providerService = new CodeExecutionService(providerBus, providerCapabilities);
      await providerService.init();
      const remoteProvider = new PiscinaCodeExecutionProvider({ maxConcurrency: 1, idleTimeoutMs: 500 });
      const transport = createBidirectionalTransportPair({ label: 'code-execution-remote' });
      callerBus.registerTransport(transport.sideA);
      providerBus.registerTransport(transport.sideB);
      callerBus
        .getContext()
        .remoteRequestHandlers.set('code-execution.execute', [{ transport: transport.sideA.name, priority: 0 }]);
      await registerCodeExecutionProvider(providerBus, remoteProvider);

      const executeRemotely = (files: Readonly<Record<string, string>>, input: JsonValue = null) =>
        callerBus.request(CodeExecutionSubjects.execute, createRequest(files, input), NO_BUS_DEADLINE);

      try {
        // This first response proves ordinary CodeExecution routing crosses the
        // real transport and executes on the provider host. It also warms the
        // remote pool before the propagated deadline starts running.
        expect(await executeRemotely(ANSWERING_PROGRAM)).toEqual({ status: 'completed', value: 7 });

        const startedPath = scratch.path('started');
        const observer = observeSettlement(providerBus);

        try {
          const pending = callerBus.request(
            CodeExecutionSubjects.execute,
            createRequest(NEVER_RETURNING_PROGRAM, { startedPath }),
            { timeout: PROPAGATED_DEADLINE_MS },
          );
          // The deadline may only fire once the remote program is provably
          // running. Without this the case could settle before dispatch and
          // would prove deadline propagation alone, not worker termination.
          await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);

          // The caller's timer and the propagated deadline are the same instant,
          // so it may observe either the remote outcome or its own timeout.
          await pending.catch(() => undefined);

          expect(await observer.settled).toEqual({
            status: 'timed_out',
            error: { code: 'execution_timeout', message: expect.any(String) },
          });

          // The remote pool has one thread and the timed-out program never
          // returns, so this can only complete if that remote worker was ended.
          expect(await executeRemotely(ANSWERING_PROGRAM)).toEqual({ status: 'completed', value: 7 });
        } finally {
          observer.stop();
        }
      } finally {
        await runTeardown([
          () => unregisterCodeExecutionProvider(providerBus, remoteProvider.id),
          () => providerService.destroy(),
          () => remoteProvider.dispose(),
          () => providerCapabilities.destroy(),
        ]);
        callerBus.disconnect();
        providerBus.disconnect();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'tears down in host order, leaving no handler, worker, or program root',
    async () => {
      await registerCodeExecutionProvider(bus, provider);
      const startedPath = scratch.path('started');
      // An execution is deliberately in flight: teardown has to end a program
      // that would never return on its own, not wait for it.
      const inFlight = bus.request(
        CodeExecutionSubjects.execute,
        createRequest(NEVER_RETURNING_PROGRAM, { startedPath }),
        NO_BUS_DEADLINE,
      );
      await waitForPath(startedPath, PROGRAM_START_TIMEOUT_MS);

      // 1. Withdraw the registration. The router still answers; the registry
      //    no longer offers the provider it was told to forget.
      await unregisterCodeExecutionProvider(bus, provider.id);
      expect(capabilities.getProviders(CODE_EXECUTION_CAPABILITY_ID)).toEqual([]);
      expect(await execute(ANSWERING_PROGRAM)).toMatchObject({
        status: 'failed',
        error: { code: 'provider_unavailable' },
      });

      // 2. Destroy the router. The subject has no handler left, so no further
      //    invocation can reach it; the one already dispatched keeps running.
      await service.destroy();
      await expect(execute(ANSWERING_PROGRAM)).rejects.toThrow();

      // 3. Dispose the provider. The barrier terminates the worker still
      //    running the never-returning program and drains the invocation, so
      //    the caller that was waiting on it settles instead of hanging.
      await provider.dispose();
      expect(await inFlight).toMatchObject({ status: 'failed', error: { code: 'provider_unavailable' } });
      expect(await scratch.listProgramRoots()).toEqual([]);

      // 4. Destroy the registry last: it outlives everything that registered
      //    into it.
      await capabilities.destroy();
      await expect(
        bus.request(CapabilitySubjects.listProviders, { capabilityId: CODE_EXECUTION_CAPABILITY_ID }),
      ).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );
});
