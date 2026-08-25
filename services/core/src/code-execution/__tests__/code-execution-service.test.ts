import { setTimeout as delay } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  CODE_EXECUTION_CAPABILITY_ID,
  CapabilitySubjects,
  CodeExecutionSubjects,
  registerCodeExecutionProvider,
  unregisterCodeExecutionProvider,
  type CodeExecutionOutcome,
  type CodeExecutionProviderContext,
  type CodeExecutionRequest,
  type CodeExecutionTrustLevel,
  type ICapabilityProvider,
  type ICodeExecutionProvider,
} from '@makaio/contracts';
import type { ExtensionToken, NodeExtensionContext } from '@makaio/contracts';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { DeferredPromise } from '@makaio/utils';
import { CapabilityService } from '../../capability/capability-service.js';
import { CapabilityToken } from '../../capability/package.js';
import { frameworkCorePackages } from '../../framework-packages.js';
import { CodeExecutionService } from '../code-execution-service.js';
import { codeExecutionPackage, CodeExecutionServiceToken } from '../package.js';

/** Behavior a test provider runs when its `execute` entry point is reached. */
type ProviderBehavior = (
  request: CodeExecutionRequest,
  context: CodeExecutionProviderContext,
) => Promise<CodeExecutionOutcome>;

/** Construction options for a concrete test provider. */
interface TestProviderOptions {
  /** Provider identifier, also used for tie-break assertions. */
  readonly id: string;
  /** Selection priority; higher wins. */
  readonly priority?: number;
  /** Runtime tag exposed for requirement filtering. */
  readonly runtime?: string;
  /** Language tag exposed for requirement filtering. */
  readonly language?: string;
  /** Module format exposed for requirement filtering. */
  readonly moduleFormat?: string;
  /** Trust level exposed for requirement filtering. */
  readonly trust?: CodeExecutionTrustLevel;
  /** What the provider does once invoked. */
  readonly behavior?: ProviderBehavior;
}

/**
 * Concrete code-execution provider used across the routing cases.
 *
 * A real implementation of the contract, not a stand-in: the service reads
 * its declared fields for selection and calls the same `execute` entry point
 * a shipped provider would expose.
 */
class TestCodeExecutionProvider implements ICodeExecutionProvider {
  public readonly id: string;
  public readonly displayName: string;
  public readonly priority: number;
  public readonly runtime: string;
  public readonly language: string;
  public readonly moduleFormat: string;
  public readonly trust: CodeExecutionTrustLevel;

  /** Number of times this provider was invoked. */
  public calls = 0;
  /** Effective execution context observed on the most recent invocation. */
  public lastContext: CodeExecutionProviderContext | undefined;

  private readonly behavior: ProviderBehavior;
  private readonly entry = new DeferredPromise<void>();

  public constructor(options: TestProviderOptions) {
    this.id = options.id;
    this.displayName = `Provider ${options.id}`;
    this.priority = options.priority ?? 0;
    this.runtime = options.runtime ?? 'node';
    this.language = options.language ?? 'typescript';
    this.moduleFormat = options.moduleFormat ?? 'esm';
    this.trust = options.trust ?? 'trusted-code-only';
    this.behavior = options.behavior ?? (() => Promise.resolve({ status: 'completed', value: `ran:${options.id}` }));
  }

  /** Resolves the first time `execute` is entered. */
  public get entered(): Promise<void> {
    return this.entry.getPromise();
  }

  public execute(request: CodeExecutionRequest, context: CodeExecutionProviderContext): Promise<CodeExecutionOutcome> {
    this.calls += 1;
    this.lastContext = context;
    this.entry.resolve();
    return this.behavior(request, context);
  }
}

/** Provider behavior that never settles on its own. */
const neverSettles: ProviderBehavior = () => new Promise<CodeExecutionOutcome>(() => undefined);

/** Attempts made to collect a value before the retention assertion gives up. */
const COLLECTION_ATTEMPTS = 10;

/**
 * Timer delay of the final settling round, in milliseconds.
 *
 * The rounds above it yield with a zero delay, which drains the microtask queue
 * and one timer turn. A retainer released by a timer scheduled later in the same
 * turn would still be alive at that point, so the last round waits long enough
 * for such a timer to have fired before the one collection that decides the
 * assertion.
 */
const SETTLING_DELAY_MS = 10;

/**
 * Force garbage collection, then report whether a weakly held value survived.
 *
 * V8 exposes `gc()` only behind a flag the test runner does not set, so the flag
 * is set on the running isolate and the intrinsic is read out of a fresh context
 * — the supported way to reach it without controlling the command line. The flag
 * is an isolate-wide setting shared with every other test in the file, so it is
 * cleared again on the way out rather than left on for the file's lifetime.
 *
 * Two details are load-bearing. The value is dereferenced exactly once, at the
 * end: `deref()` marks its target strongly reachable for the remainder of the
 * current job, so polling it between collections would keep alive precisely the
 * value the caller is asking about. And each round yields to the event loop,
 * because a value still reachable from a pending microtask is not garbage yet.
 * @param reference - Weak reference to the value that must become unreachable.
 * @returns The value if it survived, otherwise `undefined`.
 */
async function collectUntilUnreachable(reference: WeakRef<object>): Promise<object | undefined> {
  setFlagsFromString('--expose-gc');
  try {
    const collect = runInNewContext('gc') as () => void;
    for (let attempt = 0; attempt < COLLECTION_ATTEMPTS; attempt += 1) {
      collect();
      await delay(0);
    }
    // One settling round before the single observation, so a retainer that only
    // a later timer turn releases is not mistaken for a leak.
    await delay(SETTLING_DELAY_MS);
    collect();
    return reference.deref();
  } finally {
    setFlagsFromString('--no-expose-gc');
  }
}

/**
 * Provider behavior that rejects once the effective signal aborts.
 * @param _request - Unused; this behavior reacts only to the effective signal.
 * @param context - Effective execution context whose signal ends the invocation.
 * @returns A promise that rejects when the effective signal aborts.
 */
const rejectsOnAbort: ProviderBehavior = (_request, context) =>
  new Promise<CodeExecutionOutcome>((_resolve, reject) => {
    context.signal.addEventListener('abort', () => reject(new Error('provider stopped')), { once: true });
  });

/**
 * Build a schema-valid execution request.
 * @param overrides - Fields that differentiate this request from the default.
 * @returns A request the `code-execution.execute` subject accepts.
 */
function makeRequest(overrides: Partial<CodeExecutionRequest> = {}): CodeExecutionRequest {
  return {
    invocationId: 'inv-1',
    program: {
      files: { 'main.ts': 'export default (): number => 1;' },
      entryFile: 'main.ts',
      exportName: 'default',
    },
    arguments: null,
    timeoutMs: 1_000,
    ...overrides,
  };
}

/**
 * Build a request-shaped object that throws when its program is read.
 *
 * Zod's `safeParse` contains schema violations but not exceptions raised by
 * the value under inspection, so a payload like this is what distinguishes a
 * contained trust boundary from one whose failure escapes as a rejected bus
 * handler. The getter is real, not stubbed: it throws on the same first read
 * the parser performs.
 * @returns A payload whose `program` accessor throws.
 */
function makeHostileRequest(): CodeExecutionRequest {
  return {
    ...makeRequest(),
    get program(): never {
      throw new Error('hostile payload accessor');
    },
  };
}

/**
 * Build an outcome-shaped object that throws when its discriminant is read.
 *
 * The provider boundary is the router's second parse of a value it did not
 * produce, and a provider is as capable of handing back an unreadable object
 * as an upstream handler is.
 * @returns An outcome whose `status` accessor throws.
 */
function makeHostileOutcome(): CodeExecutionOutcome {
  return {
    get status(): never {
      throw new Error('hostile outcome accessor');
    },
    get value(): never {
      throw new Error('hostile outcome accessor');
    },
  };
}

describe('CodeExecutionService', () => {
  let bus: IMakaioBus;
  let capabilities: CapabilityService;
  let service: CodeExecutionService;

  /**
   * Run one invocation through the real bus subject.
   * @param overrides - Request fields for this invocation.
   * @returns The normalized terminal outcome the handler produced.
   */
  async function execute(overrides: Partial<CodeExecutionRequest> = {}): Promise<CodeExecutionOutcome> {
    return bus.request(CodeExecutionSubjects.execute, makeRequest(overrides));
  }

  beforeEach(async () => {
    bus = createBusInstance();
    capabilities = new CapabilityService(bus);
    await capabilities.init();
    service = new CodeExecutionService(bus, capabilities);
    await service.init();
  });

  afterEach(async () => {
    try {
      await service.destroy();
    } finally {
      await capabilities.destroy();
    }
  });

  describe('provider resolution through the capability registry', () => {
    it('fails with provider_unavailable when nothing is registered', async () => {
      expect(await execute()).toEqual({
        status: 'failed',
        error: { code: 'provider_unavailable', message: expect.any(String) },
      });
    });

    it('routes to a provider registered through the public helper', async () => {
      const provider = new TestCodeExecutionProvider({ id: 'node-runner' });
      await registerCodeExecutionProvider(bus, provider);

      expect(await execute()).toEqual({ status: 'completed', value: 'ran:node-runner' });
      expect(provider.calls).toBe(1);
    });

    it('routes to the replacement after a provider re-registers under the same id', async () => {
      const first = new TestCodeExecutionProvider({ id: 'runner' });
      const replacement = new TestCodeExecutionProvider({
        id: 'runner',
        behavior: () => Promise.resolve({ status: 'completed', value: 'replaced' }),
      });
      await registerCodeExecutionProvider(bus, first);
      await registerCodeExecutionProvider(bus, replacement);

      expect(await execute()).toEqual({ status: 'completed', value: 'replaced' });
      expect(first.calls).toBe(0);
      expect(replacement.calls).toBe(1);
      expect(capabilities.getProviders(CODE_EXECUTION_CAPABILITY_ID)).toHaveLength(1);
    });

    it('stops routing once a provider unregisters', async () => {
      const provider = new TestCodeExecutionProvider({ id: 'runner' });
      await registerCodeExecutionProvider(bus, provider);
      await unregisterCodeExecutionProvider(bus, 'runner');

      expect(await execute()).toMatchObject({ status: 'failed', error: { code: 'provider_unavailable' } });
      expect(provider.calls).toBe(0);
    });

    it('keeps no registry of its own, so late registrations are picked up', async () => {
      expect(await execute()).toMatchObject({ status: 'failed', error: { code: 'provider_unavailable' } });

      await registerCodeExecutionProvider(bus, new TestCodeExecutionProvider({ id: 'late' }));

      expect(await execute()).toEqual({ status: 'completed', value: 'ran:late' });
    });

    it('admits the highest priority provider and pins an exact provider id on request', async () => {
      const low = new TestCodeExecutionProvider({ id: 'low', priority: 1 });
      const high = new TestCodeExecutionProvider({ id: 'high', priority: 10 });
      await registerCodeExecutionProvider(bus, low);
      await registerCodeExecutionProvider(bus, high);

      expect(await execute()).toEqual({ status: 'completed', value: 'ran:high' });
      expect(await execute({ requirements: { providerId: 'low' } })).toEqual({
        status: 'completed',
        value: 'ran:low',
      });
    });

    it('fails with provider_unavailable when no provider satisfies the requirements', async () => {
      await registerCodeExecutionProvider(bus, new TestCodeExecutionProvider({ id: 'node-only', runtime: 'node' }));

      expect(await execute({ requirements: { runtime: 'deno' } })).toMatchObject({
        status: 'failed',
        error: { code: 'provider_unavailable' },
      });
    });

    it('fails with invalid_provider instead of invoking a malformed registration', async () => {
      // The capability registry stores live objects and validates none of them,
      // so a contract-violating registration reaches selection intact.
      const malformed: ICapabilityProvider = { id: 'broken', displayName: 'Broken' };
      await bus.emit(CapabilitySubjects.register, {
        capabilityId: CODE_EXECUTION_CAPABILITY_ID,
        provider: malformed,
      });

      expect(await execute()).toMatchObject({ status: 'failed', error: { code: 'invalid_provider' } });
    });
  });

  describe('request validation at the router boundary', () => {
    it('fails with invalid_program when an upstream handler replaced the payload', async () => {
      const provider = new TestCodeExecutionProvider({ id: 'runner' });
      await registerCodeExecutionProvider(bus, provider);

      // The bus validated the original payload, but a higher-priority handler
      // may replace it before the router runs. A subject that executes
      // submitted code re-validates rather than trusting the chain.
      const stopRewriting = bus.on(
        CodeExecutionSubjects.execute,
        async (ctx) => {
          ctx.replacePayload({ ...makeRequest(), timeoutMs: -1 });
          await ctx.next();
        },
        { priority: 100 },
      );

      try {
        expect(await execute()).toMatchObject({ status: 'failed', error: { code: 'invalid_program' } });
        expect(provider.calls).toBe(0);
      } finally {
        stopRewriting();
      }
    });

    it('reports invalid_program for a payload that throws while being validated', async () => {
      const provider = new TestCodeExecutionProvider({ id: 'runner' });
      await registerCodeExecutionProvider(bus, provider);

      const stopRewriting = bus.on(
        CodeExecutionSubjects.execute,
        async (ctx) => {
          ctx.replacePayload(makeHostileRequest());
          await ctx.next();
        },
        { priority: 100 },
      );

      try {
        // A payload the parser cannot even read is a validation failure like
        // any other. Letting the exception escape would reject the handler and
        // turn a hostile payload into a subject-level fault.
        expect(await execute()).toMatchObject({ status: 'failed', error: { code: 'invalid_program' } });
        expect(provider.calls).toBe(0);
      } finally {
        stopRewriting();
      }
    });
  });

  describe('outcome normalization', () => {
    it('normalizes a provider throw to provider_failed without leaking its internals', async () => {
      const secret = 'ENOENT: /srv/run/secrets/api-token at Object.<anonymous> (/srv/exec/42/entry.mjs:7:11)';
      await registerCodeExecutionProvider(
        bus,
        new TestCodeExecutionProvider({
          id: 'thrower',
          behavior: () => Promise.reject(new Error(secret)),
        }),
      );

      const outcome = await execute();

      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'provider_failed' } });
      const message = outcome.status === 'failed' ? outcome.error.message : '';
      expect(message).toContain('thrower');
      expect(message).not.toContain(secret);
      expect(message).not.toContain('/srv/');
      expect(message).not.toContain('at Object.');
    });

    it('observes a rejected settlement when the provider mutates the live request during invocation', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);

      try {
        await registerCodeExecutionProvider(
          bus,
          new TestCodeExecutionProvider({
            id: 'mutates-request',
            behavior: (request) => {
              Object.defineProperty(request, 'invocationId', {
                configurable: true,
                get: (): never => {
                  throw new Error('hostile provider mutation');
                },
              });
              return Promise.reject(new Error('provider rejection'));
            },
          }),
        );
        expect(await execute()).toMatchObject({ status: 'failed', error: { code: 'provider_failed' } });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('answers provider_failed for a provider whose id becomes unreadable after admission', async () => {
      // Selection reads every declared field exactly once, under containment.
      // The failure path must live on that snapshot: re-reading `id` to build a
      // diagnostic or a failure summary would put an untrusted property access
      // on the very path that exists to normalize an untrusted provider, and a
      // registration that answers selection and then throws would reject the
      // bus handler instead of producing an outcome.
      const provider = new TestCodeExecutionProvider({
        id: 'fickle',
        behavior: () => Promise.reject(new Error('boom')),
      });
      let reads = 0;
      Object.defineProperty(provider, 'id', {
        enumerable: true,
        configurable: true,
        get: () => {
          reads += 1;
          if (reads > 1) throw new Error('hostile second read of id');
          return 'fickle';
        },
      });
      await registerCodeExecutionProvider(bus, provider);

      const outcome = await execute();

      expect(outcome).toMatchObject({ status: 'failed', error: { code: 'provider_failed' } });
      // The snapshot is what the summary names, so the identifier survives even
      // though the live object can no longer answer for it.
      expect(outcome.status === 'failed' ? outcome.error.message : '').toContain('fickle');
    });

    it('invokes the entry point selection admitted, not whatever the registration answers later', async () => {
      // Selection validates `execute` as part of deciding whether to admit the
      // registration at all. Re-reading it at the point of use would make that
      // check a formality: a registration is free to answer a real handler once
      // and something else — or nothing — on the next read, and the router would
      // then run a callable admission never saw, or reject the bus handler over
      // a property access on the very path that exists to normalize a faulty
      // provider.
      const provider = new TestCodeExecutionProvider({ id: 'fickle-entry' });
      // Deliberately the unbound method: carrying `execute` out of selection
      // only works if it is invoked with the live registration as its `this`,
      // so a snapshot that dropped the binding would fail this case too.
      const admitted = TestCodeExecutionProvider.prototype.execute;
      let reads = 0;
      Object.defineProperty(provider, 'execute', {
        enumerable: true,
        configurable: true,
        get: () => {
          reads += 1;
          if (reads > 1) throw new Error('hostile second read of execute');
          return admitted;
        },
      });
      await registerCodeExecutionProvider(bus, provider);

      expect(await execute()).toEqual({ status: 'completed', value: 'ran:fickle-entry' });
      // The single read is the selection snapshot: nothing read it again.
      expect(reads).toBe(1);
      expect(provider.calls).toBe(1);
    });

    it('invokes the admitted entry point through the intrinsic, not through its own "call"', async () => {
      // `Function.prototype.call` is an ordinary inherited property, so the
      // submitted function can shadow it. Reaching the entry point through
      // `execute.call(...)` would therefore be one more untrusted property read
      // on the registration's own object graph — a throwing own `call` would
      // reject the bus handler, and a substituted callable would run instead of
      // the function selection admitted.
      const provider = new TestCodeExecutionProvider({ id: 'shadowed-call' });
      const admitted = provider.execute.bind(provider);
      Object.defineProperty(admitted, 'call', {
        configurable: true,
        get: () => {
          throw new Error('hostile own "call" property');
        },
      });
      Object.defineProperty(provider, 'execute', { enumerable: true, configurable: true, value: admitted });
      await registerCodeExecutionProvider(bus, provider);

      expect(await execute()).toEqual({ status: 'completed', value: 'ran:shadowed-call' });
      expect(provider.calls).toBe(1);
    });

    it('normalizes an outcome that violates the response contract to invalid_provider', async () => {
      await registerCodeExecutionProvider(
        bus,
        new TestCodeExecutionProvider({
          id: 'liar',
          // Type-valid but schema-invalid: failure messages are bounded to a
          // non-empty summary at the contract boundary.
          behavior: () => Promise.resolve({ status: 'failed', error: { code: 'handler_failed', message: '' } }),
        }),
      );

      expect(await execute()).toMatchObject({ status: 'failed', error: { code: 'invalid_provider' } });
    });

    it('reports invalid_provider for a completed value the response contract cannot carry faithfully', async () => {
      // Zod drops a `__proto__` own key while parsing a record, so a value like
      // this would otherwise reach the caller with that key silently removed —
      // a result the provider never produced. The router must classify it, not
      // rewrite it. `JSON.parse` is how a provider that fetched its result over
      // a wire ends up holding exactly this shape.
      const wireValue: unknown = JSON.parse('{"outer":{"__proto__":{"polluted":true}}}');
      if (typeof wireValue !== 'object' || wireValue === null) throw new Error('unreachable');
      await registerCodeExecutionProvider(
        bus,
        new TestCodeExecutionProvider({
          id: 'polluter',
          behavior: () => Promise.resolve({ status: 'completed', value: wireValue }),
        }),
      );

      expect(await execute()).toMatchObject({ status: 'failed', error: { code: 'invalid_provider' } });

      // Discriminator: the identical value without the offending key completes,
      // so the rejection is the key and not the shape around it.
      await unregisterCodeExecutionProvider(bus, 'polluter');
      await registerCodeExecutionProvider(
        bus,
        new TestCodeExecutionProvider({
          id: 'clean',
          behavior: () => Promise.resolve({ status: 'completed', value: { outer: { polluted: true } } }),
        }),
      );
      expect(await execute()).toEqual({ status: 'completed', value: { outer: { polluted: true } } });
    });

    it('reports invalid_provider for an outcome that throws while being validated', async () => {
      await registerCodeExecutionProvider(
        bus,
        new TestCodeExecutionProvider({
          id: 'unreadable',
          behavior: () => Promise.resolve(makeHostileOutcome()),
        }),
      );

      // Same containment as the request boundary: an unreadable value is a
      // contract violation by the provider, not a fault of the subject.
      expect(await execute()).toMatchObject({ status: 'failed', error: { code: 'invalid_provider' } });
    });

    it('never falls back to a second provider once one has been admitted', async () => {
      const admitted = new TestCodeExecutionProvider({
        id: 'admitted',
        priority: 10,
        behavior: () => Promise.reject(new Error('boom')),
      });
      const standby = new TestCodeExecutionProvider({ id: 'standby', priority: 1 });
      await registerCodeExecutionProvider(bus, admitted);
      await registerCodeExecutionProvider(bus, standby);

      expect(await execute()).toMatchObject({ status: 'failed', error: { code: 'provider_failed' } });
      expect(admitted.calls).toBe(1);
      expect(standby.calls).toBe(0);
    });

    it('passes the effective signal and deadline to the provider', async () => {
      const provider = new TestCodeExecutionProvider({ id: 'observer' });
      await registerCodeExecutionProvider(bus, provider);

      const before = Date.now();
      await execute({ timeoutMs: 5_000 });

      expect(provider.lastContext?.signal.aborted).toBe(false);
      expect(provider.lastContext?.deadlineEpochMs).toBeGreaterThanOrEqual(before + 5_000);
      expect(provider.lastContext?.deadlineEpochMs).toBeLessThanOrEqual(Date.now() + 5_000);
    });
  });

  describe('budget and cancellation ownership', () => {
    it('normalizes an exhausted budget to timed_out and stops waiting on the provider', async () => {
      const provider = new TestCodeExecutionProvider({ id: 'hangs', behavior: neverSettles });
      await registerCodeExecutionProvider(bus, provider);

      vi.useFakeTimers();
      try {
        // `timeout: 0` removes the bus deadline so the request budget is the
        // only thing that can settle this invocation.
        const pending = bus.request(CodeExecutionSubjects.execute, makeRequest({ timeoutMs: 1_000 }), { timeout: 0 });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(await pending).toEqual({
          status: 'timed_out',
          error: { code: 'execution_timeout', message: expect.any(String) },
        });
        expect(provider.lastContext?.signal.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps timeout classification private when a provider shadows its signal reason', async () => {
      const provider = new TestCodeExecutionProvider({
        id: 'shadows-abort-reason',
        behavior: (_request, context) => {
          // AbortSignal.reason is a configurable prototype accessor in Node, so
          // a live provider can shadow its own view even though the router's
          // private controller later records the real timeout.
          Object.defineProperty(context.signal, 'reason', { configurable: true, value: 'cancellation' });
          return neverSettles(_request, context);
        },
      });
      await registerCodeExecutionProvider(bus, provider);

      vi.useFakeTimers();
      try {
        const pending = bus.request(CodeExecutionSubjects.execute, makeRequest({ timeoutMs: 1_000 }), { timeout: 0 });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(await pending).toEqual({
          status: 'timed_out',
          error: { code: 'execution_timeout', message: expect.any(String) },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases the request once a provider that never settles has been timed out', async () => {
      // A provider is free to ignore its abort signal and never settle. The
      // timeout arm then answers the caller while the router's own continuation
      // stays suspended for the rest of the process — so whatever that
      // continuation still holds is held forever, once per timed-out invocation.
      // A `CodeExecutionRequest` carries the whole submitted program and its
      // arguments, megabytes of it, which makes "the continuation holds nothing
      // proportional to the request" a real bound rather than a style rule.
      //
      // The weakly held value is the *parsed* request the router handed the
      // provider, which no test-local variable and no bus record refers to — so
      // if it survives collection, the router is what is holding it.
      //
      // The unsettled promise is kept reachable from `stranded`, and that is
      // what makes the case discriminating rather than vacuous: a pending
      // promise nothing refers to forms an unreachable cycle with the
      // continuation waiting on it, so both would be collected — and the request
      // with them — no matter what that continuation captured. A real provider
      // that is stuck is holding its own resolver, which is what this models.
      const stranded: Array<(outcome: CodeExecutionOutcome) => void> = [];
      let admitted: WeakRef<CodeExecutionRequest> | undefined;
      const provider = new TestCodeExecutionProvider({
        id: 'ignores-abort',
        behavior: (request) => {
          admitted = new WeakRef(request);
          return new Promise<CodeExecutionOutcome>((resolve) => stranded.push(resolve));
        },
      });
      await registerCodeExecutionProvider(bus, provider);

      vi.useFakeTimers();
      try {
        const pending = bus.request(CodeExecutionSubjects.execute, makeRequest({ timeoutMs: 1_000 }), { timeout: 0 });
        await vi.advanceTimersByTimeAsync(1_000);

        expect(await pending).toMatchObject({ status: 'timed_out' });
      } finally {
        vi.useRealTimers();
      }

      if (admitted === undefined) throw new Error('the provider was never invoked');
      // Guards the fixture: the promise must still be stranded, or the
      // continuation would have resumed and released everything on its own.
      expect(stranded).toHaveLength(1);
      expect(await collectUntilUnreachable(admitted)).toBeUndefined();
    });

    it('settles a cancelled invocation as cancelled even though the caller sees a rejection', async () => {
      const provider = new TestCodeExecutionProvider({ id: 'cancellable', behavior: rejectsOnAbort });
      await registerCodeExecutionProvider(bus, provider);

      // The typed `cancelled` outcome is an internal settlement invariant: an
      // aborted local caller observes a rejected request, so the outcome is
      // read from the handler chain rather than from the caller's promise.
      const settled = new DeferredPromise<void>();
      let observed: CodeExecutionOutcome | undefined;
      const stopObserving = bus.on(
        CodeExecutionSubjects.execute,
        async (ctx) => {
          await ctx.next();
          observed = ctx.result;
          settled.resolve();
        },
        { priority: 100 },
      );

      try {
        const caller = new AbortController();
        const pending = bus.request(CodeExecutionSubjects.execute, makeRequest({ timeoutMs: 60_000 }), {
          timeout: 0,
          signal: caller.signal,
        });
        await provider.entered;
        caller.abort(new Error('caller went away'));

        await expect(pending).rejects.toThrow();
        await settled.getPromise();

        expect(observed).toEqual({
          status: 'cancelled',
          error: { code: 'cancelled', message: expect.any(String) },
        });
      } finally {
        stopObserving();
      }
    });

    it('settles an already-abandoned caller as cancelled even with nothing registered', async () => {
      // Abort ownership is established before selection. The caller had
      // already decided this invocation's fate, so answering
      // `provider_unavailable` would blame local composition for something the
      // registry never got asked about.
      const settled = new DeferredPromise<void>();
      let observed: CodeExecutionOutcome | undefined;
      const stopObserving = bus.on(
        CodeExecutionSubjects.execute,
        async (ctx) => {
          await ctx.next();
          observed = ctx.result;
          settled.resolve();
        },
        { priority: 100 },
      );

      try {
        expect(capabilities.getProviders(CODE_EXECUTION_CAPABILITY_ID)).toHaveLength(0);
        const caller = new AbortController();
        caller.abort(new Error('caller went away before dispatch'));

        const pending = bus.request(CodeExecutionSubjects.execute, makeRequest(), {
          timeout: 0,
          signal: caller.signal,
        });

        await expect(pending).rejects.toThrow();
        await settled.getPromise();

        expect(observed).toEqual({
          status: 'cancelled',
          error: { code: 'cancelled', message: expect.any(String) },
        });
      } finally {
        stopObserving();
      }
    });
  });

  describe('lifecycle', () => {
    it('removes the execute handler on destroy and leaves the registry untouched', async () => {
      await registerCodeExecutionProvider(bus, new TestCodeExecutionProvider({ id: 'runner' }));
      expect(await execute()).toEqual({ status: 'completed', value: 'ran:runner' });

      await service.destroy();

      await expect(execute()).rejects.toThrow();
      expect(capabilities.getProviders(CODE_EXECUTION_CAPABILITY_ID)).toHaveLength(1);
    });

    it('tolerates a repeated destroy and can be initialized again', async () => {
      await registerCodeExecutionProvider(bus, new TestCodeExecutionProvider({ id: 'runner' }));

      await service.destroy();
      await service.destroy();
      await service.init();

      expect(await execute()).toEqual({ status: 'completed', value: 'ran:runner' });
    });
  });

  describe('codeExecutionPackage', () => {
    /**
     * Build the extension context a host hands to `create`.
     * @param hostBus - Bus the created service registers its handler on.
     * @param registry - Capability registry the host exposes, or `undefined` when it has none.
     * @returns Node extension context for `codeExecutionPackage.create`.
     */
    function makeContext(
      hostBus: IMakaioBus,
      registry: CapabilityService | undefined,
    ): NodeExtensionContext<IMakaioBus> {
      return {
        ...makeStubExtensionContext(hostBus),
        bus: hostBus,
        platform: process.platform,
        homedir: '/tmp',
        makaioHome: '/tmp/.makaio-test',
        username: 'test',
        getService: <T>(token: ExtensionToken<T>): T | undefined =>
          token.name === CapabilityToken.name ? (registry as T | undefined) : undefined,
      };
    }

    /**
     * Narrow what `create` returned to the concrete service.
     * @param created - Value produced by `codeExecutionPackage.create`.
     */
    function expectCodeExecutionService(
      created: ReturnType<NonNullable<typeof codeExecutionPackage.create>> | undefined,
    ): asserts created is CodeExecutionService {
      expect(created).toBeInstanceOf(CodeExecutionService);
    }

    it('declares a required dependency on the capability registry', () => {
      expect(codeExecutionPackage.name).toBe(CodeExecutionServiceToken.name);
      const dependencies = codeExecutionPackage.dependencies ?? [];
      expect(dependencies.map((declared) => declared.name)).toContain(CapabilityToken.name);
      expect(dependencies.every((declared) => declared.optional !== true)).toBe(true);
    });

    it('stays out of the framework core package list so a host must opt in', () => {
      expect(frameworkCorePackages.map((pkg) => pkg.name)).not.toContain(codeExecutionPackage.name);
    });

    it('creates a service that routes on the host bus against the host registry', async () => {
      const hostBus = createBusInstance();
      const hostRegistry = new CapabilityService(hostBus);
      await hostRegistry.init();
      const created = codeExecutionPackage.create?.(makeContext(hostBus, hostRegistry));
      expectCodeExecutionService(created);

      try {
        await created.init();
        await registerCodeExecutionProvider(hostBus, new TestCodeExecutionProvider({ id: 'host-runner' }));

        expect(await hostBus.request(CodeExecutionSubjects.execute, makeRequest())).toEqual({
          status: 'completed',
          value: 'ran:host-runner',
        });
      } finally {
        await created.destroy();
        await hostRegistry.destroy();
      }
    });

    it('refuses to create the service when the host exposes no capability registry', () => {
      expect(() => codeExecutionPackage.create?.(makeContext(bus, undefined))).toThrow(/CapabilityService/);
    });
  });
});
