import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  defineAutomationTrigger,
  AutomationWorkflowTrigger,
  JsonValueSchema,
  toAutomationTriggerType,
  type AutomationTriggerActivationContext,
  type AutomationTriggerCleanup,
  type AutomationTriggerEvent,
  type AutomationTriggerListener,
  type AutomationTriggerParams,
  type AutomationTriggerType,
  type JsonValue,
} from '@makaio/contracts';
import { AutomationTriggerRegistry } from '../automation-trigger-registry.js';
import { AutomationTriggerBindingRuntime } from '../automation-trigger-binding-runtime.js';
import { canonicalizeJsonRecord, createCanonicalBindingKey } from '../canonical-binding-key.js';

// ---------------------------------------------------------------------------
// Deferred helper
// ---------------------------------------------------------------------------

/** Manual promise handle used to hold an activation open inside a test. */
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/**
 * Creates a deferred promise handle for controlling activation timing.
 * @returns A promise plus its idempotent resolver.
 */
function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

/**
 * Rejects when a lifecycle operation does not settle in time.
 *
 * The deadlock regression tests below would otherwise hang the suite instead of
 * failing: every one of them exercises a path where extension code re-enters the
 * runtime, which used to wait on a lane the caller still held.
 * @typeParam TResult - Value produced by the operation.
 * @param operation - Runtime operation expected to settle.
 * @param label - Operation name used in the timeout message.
 * @param timeoutMs - Budget before the guard fails the test.
 * @returns The operation's result.
 */
async function withinTimeout<TResult>(operation: Promise<TResult>, label: string, timeoutMs = 1_000): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([operation, guard]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Trigger probes — real AutomationTriggerType values with observable lifecycle
// ---------------------------------------------------------------------------

/** Emit channel signature exposed by a probe for direct source simulation. */
type ProbeEmit = (payload: JsonValue, metadata?: { readonly correlationId?: string }) => Promise<void>;

/** Activation signature of a probe, matching the registry-boundary contract. */
type ProbeActivate = (
  context: AutomationTriggerActivationContext<unknown>,
  params: AutomationTriggerParams,
) => Promise<AutomationTriggerCleanup>;

/** Construction options for {@link createProbe}. */
interface ProbeOptions {
  /** Canonical trigger kind, e.g. `demo.assignment`. */
  readonly kind: string;
  /** Live parameter schema exercised by the runtime before activation. */
  readonly paramsSchema: z.ZodType<Record<string, JsonValue>>;
  /** Live event schema exercised by the runtime before listener delivery. */
  readonly eventSchema?: z.ZodType<JsonValue>;
  /**
   * Optional hook awaited inside `activate`, used to hold an activation open or
   * to make an activation fail.
   * @param context - The activation context handed to this activation.
   */
  readonly onActivate?: (context: AutomationTriggerActivationContext<unknown>) => Promise<void> | void;
  /**
   * Optional hook awaited inside the returned cleanup, used to make a source's
   * teardown re-enter the runtime.
   */
  readonly onCleanup?: () => Promise<void> | void;
}

/** Observable trigger fixture backed by a real {@link AutomationTriggerType}. */
interface TriggerProbe {
  /** The registry-boundary trigger value to register. */
  readonly type: AutomationTriggerType;
  /** Spy wrapping the real activation body. */
  readonly activate: Mock<ProbeActivate>;
  /** Spy wrapping the real cleanup body returned by `activate`. */
  readonly cleanup: Mock<() => Promise<void>>;
  /** Activation contexts handed out, in activation order. */
  readonly contexts: readonly AutomationTriggerActivationContext<unknown>[];
  /** Schema-parsed params observed by each activation, in activation order. */
  readonly observedParams: readonly AutomationTriggerParams[];
  /** Emits through the most recent activation context. */
  readonly emit: ProbeEmit;
}

/** Default event schema shared by probes that do not need a custom one. */
const DefaultEventSchema = z.object({ issueId: z.string() });

/**
 * Builds an observable automation trigger fixture.
 *
 * The returned `type` is a real {@link AutomationTriggerType}: the schemas are
 * live Zod schemas and `activate` runs a real body that captures its context and
 * returns a real cleanup function. Spies wrap that behavior rather than
 * replacing it.
 * @param options - Probe configuration.
 * @returns The trigger plus its lifecycle observation handles.
 */
function createProbe(options: ProbeOptions): TriggerProbe {
  const cleanup = vi.fn<() => Promise<void>>(async () => {
    await options.onCleanup?.();
  });
  const contexts: AutomationTriggerActivationContext<unknown>[] = [];
  const observedParams: AutomationTriggerParams[] = [];

  const activate: Mock<ProbeActivate> = vi.fn(async (context, params) => {
    contexts.push(context);
    observedParams.push(params);
    await options.onActivate?.(context);
    return cleanup;
  });

  const type: AutomationTriggerType = {
    kind: options.kind,
    label: `${options.kind} label`,
    description: `Fires on ${options.kind}.`,
    categories: ['test'],
    paramsSchema: options.paramsSchema,
    eventSchema: options.eventSchema ?? DefaultEventSchema,
    activate,
  };

  return {
    type,
    activate,
    cleanup,
    contexts,
    observedParams,
    emit: (payload, metadata) => {
      const context = contexts.at(-1);
      if (context === undefined) {
        throw new Error(`Trigger '${options.kind}' was never activated`);
      }
      return context.emit(payload, metadata);
    },
  };
}

/**
 * Returns the first event delivered to a listener.
 * @param listener - Listener spy that is expected to have been called.
 * @returns The first delivered event envelope.
 * @throws When the listener was never called.
 */
function firstEvent(listener: Mock<AutomationTriggerListener>): AutomationTriggerEvent {
  const event = listener.mock.calls[0]?.[0];
  if (event === undefined) throw new Error('Listener was never called');
  return event;
}

/**
 * Returns the activation context of a probe's most recent activation.
 * @param probe - Probe expected to have been activated at least once.
 * @returns The most recent activation context.
 * @throws When the probe was never activated.
 */
function latestContext(probe: TriggerProbe): AutomationTriggerActivationContext<unknown> {
  const context = probe.contexts.at(-1);
  if (context === undefined) throw new Error('Probe was never activated');
  return context;
}

/** Params schema with a normalizing transform and a defaulted field. */
const AssignmentParamsSchema = z.object({
  projectKey: z.string().transform((value) => value.toUpperCase()),
  labels: z.array(z.string()).default([]),
});

/** Free-form params schema that preserves caller key insertion order. */
const FreeformParamsSchema = z.record(z.string(), JsonValueSchema);

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('canonical binding keys', () => {
  it('uses the documented `<kind>:<canonical-json>` format', () => {
    // The literal format is depended on downstream: the workflow reconciler
    // compares keys, and diagnostics quote them.
    expect(createCanonicalBindingKey('demo.assignment', { b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe(
      'demo.assignment:{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}',
    );
  });

  it('sorts object keys recursively while preserving array order', () => {
    expect(canonicalizeJsonRecord({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toEqual({
      a: { c: [{ e: 4, f: 3 }], d: 2 },
      b: 1,
    });
    expect(Object.keys(canonicalizeJsonRecord({ b: 1, a: 2 }))).toEqual(['a', 'b']);
    expect(canonicalizeJsonRecord({ order: ['b', 'a'] })['order']).toEqual(['b', 'a']);
  });

  it('orders keys by code unit, not by host locale collation', () => {
    // `'a'.localeCompare('B')` is negative in common locales, while code-unit
    // ordering puts 'B' (66) before 'a' (97). Canonical keys must not depend on
    // which collation the host's ICU build applies.
    expect(createCanonicalBindingKey('demo.assignment', { B: 1, a: 2 })).toBe('demo.assignment:{"B":1,"a":2}');
  });

  it('normalizes negative zero so params cannot disagree with their key', () => {
    expect(Object.is(canonicalizeJsonRecord({ offset: -0 })['offset'], 0)).toBe(true);
    expect(createCanonicalBindingKey('demo.assignment', { offset: -0 })).toBe(
      createCanonicalBindingKey('demo.assignment', { offset: 0 }),
    );
  });

  it('produces equal keys for reordered params and distinct keys per kind', () => {
    const left = createCanonicalBindingKey('demo.assignment', { a: 1, b: { d: 2, c: 3 } });
    const right = createCanonicalBindingKey('demo.assignment', { b: { c: 3, d: 2 }, a: 1 });

    expect(left).toBe(right);
    expect(createCanonicalBindingKey('demo.other', { a: 1, b: { d: 2, c: 3 } })).not.toBe(left);
  });
});

describe('AutomationTriggerBindingRuntime', () => {
  let bus: IMakaioBus;
  let registry: AutomationTriggerRegistry;
  let runtime: AutomationTriggerBindingRuntime;
  let assignment: TriggerProbe;

  beforeEach(async () => {
    bus = createBusInstance();
    registry = new AutomationTriggerRegistry(bus);
    await registry.init();
    runtime = new AutomationTriggerBindingRuntime(registry);
    assignment = createProbe({
      kind: 'demo.assignment',
      paramsSchema: AssignmentParamsSchema,
    });
    await registry.register('demo', [assignment.type]);
  });

  afterEach(async () => {
    await runtime.close();
    await registry.destroy();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Canonical sharing and reference counting
  // -------------------------------------------------------------------------

  describe('canonical sharing', () => {
    it('shares one activation across params that normalize to the same key', async () => {
      const firstListener = vi.fn();
      const secondListener = vi.fn();

      const first = await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, firstListener);
      const second = await runtime.subscribe(
        { kind: 'demo.assignment', params: { labels: [], projectKey: 'SHOP' } },
        secondListener,
      );

      expect(first.bindingKey).toBe(second.bindingKey);
      expect(assignment.activate).toHaveBeenCalledTimes(1);

      await assignment.emit({ issueId: 'SHOP-1' });
      expect(firstListener).toHaveBeenCalledTimes(1);
      expect(secondListener).toHaveBeenCalledTimes(1);

      await first.detach();
      expect(assignment.cleanup).not.toHaveBeenCalled();

      await second.detach();
      expect(assignment.cleanup).toHaveBeenCalledTimes(1);
    });

    it('passes the schema-parsed params to activate and reflects them in the key', async () => {
      const subscription = await runtime.subscribe(
        { kind: 'demo.assignment', params: { projectKey: 'shop' } },
        vi.fn(),
      );

      expect(assignment.observedParams[0]).toEqual({ projectKey: 'SHOP', labels: [] });
      expect(subscription.bindingKey).toBe(
        createCanonicalBindingKey('demo.assignment', { projectKey: 'SHOP', labels: [] }),
      );
    });

    it('shares bindings whose nested params differ only in key order', async () => {
      const freeform = createProbe({
        kind: 'demo.freeform',
        paramsSchema: FreeformParamsSchema,
      });
      await registry.register('demo', [assignment.type, freeform.type]);

      const first = await runtime.subscribe(
        { kind: 'demo.freeform', params: { alpha: 1, nested: { x: 1, y: 2 } } },
        vi.fn(),
      );
      const second = await runtime.subscribe(
        { kind: 'demo.freeform', params: { nested: { y: 2, x: 1 }, alpha: 1 } },
        vi.fn(),
      );

      expect(first.bindingKey).toBe(second.bindingKey);
      expect(freeform.activate).toHaveBeenCalledTimes(1);
    });

    it('activates separate bindings for materially different params', async () => {
      const first = await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, vi.fn());
      const second = await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'core' } }, vi.fn());

      expect(first.bindingKey).not.toBe(second.bindingKey);
      expect(assignment.activate).toHaveBeenCalledTimes(2);
    });

    it('activates through the typed authoring path', async () => {
      const typedCleanup = vi.fn();
      const typed = toAutomationTriggerType(
        defineAutomationTrigger({
          kind: 'typed.ping',
          label: 'Ping',
          description: 'Fires on ping.',
          categories: ['test'],
          paramsSchema: z.object({ channel: z.string() }),
          eventSchema: z.object({ pings: z.number() }),
          activate: async (context) => {
            await context.emit({ pings: 1 });
            return typedCleanup;
          },
        }),
      );
      await registry.register('typed', [typed]);

      const listener = vi.fn();
      const subscription = await runtime.subscribe({ kind: 'typed.ping', params: { channel: 'ops' } }, listener);

      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ kind: 'typed.ping', payload: { pings: 1 } }));

      await subscription.detach();
      expect(typedCleanup).toHaveBeenCalledTimes(1);
    });

    it('parses persisted schema input exactly once before activation', async () => {
      const observedParams: AutomationTriggerParams[] = [];
      const typed = defineAutomationTrigger({
        kind: 'typed.normalized',
        label: 'Normalized',
        description: 'Normalizes activation parameters.',
        categories: ['test'],
        paramsSchema: z.object({ channel: z.string().transform((value) => `${value}!`) }),
        eventSchema: z.object({}),
        activate: async (_context, params) => {
          observedParams.push(params);
          return async () => undefined;
        },
      });
      await registry.register('typed', [toAutomationTriggerType(typed)]);
      const authored = AutomationWorkflowTrigger(typed, { params: { channel: 'ops' } });

      expect(authored.params).toEqual({ channel: 'ops' });
      await runtime.subscribe(authored, vi.fn());

      expect(observedParams).toEqual([{ channel: 'ops!' }]);
    });
  });

  // -------------------------------------------------------------------------
  // Parameter validation
  // -------------------------------------------------------------------------

  describe('parameter validation', () => {
    it('rejects invalid parameters before activation', async () => {
      await expect(
        runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 7 } }, vi.fn()),
      ).rejects.toThrow();

      expect(assignment.activate).not.toHaveBeenCalled();
    });

    it('rejects parse output that is not JSON compatible', async () => {
      const nonJson = createProbe({
        kind: 'demo.non-json',
        paramsSchema: z.object({
          handler: z.string().transform((value) => () => value),
        }),
      });
      await registry.register('demo', [assignment.type, nonJson.type]);

      await expect(
        runtime.subscribe({ kind: 'demo.non-json', params: { handler: 'noop' } }, vi.fn()),
      ).rejects.toThrow();

      expect(nonJson.activate).not.toHaveBeenCalled();
    });

    it('rejects unknown trigger kinds', async () => {
      await expect(runtime.subscribe({ kind: 'demo.missing', params: {} }, vi.fn())).rejects.toThrow(/demo\.missing/);
    });
  });

  // -------------------------------------------------------------------------
  // Event validation and delivery
  // -------------------------------------------------------------------------

  describe('event delivery', () => {
    it('keeps scalar events available to generic runtime consumers while marking them workflow-incompatible', async () => {
      const scalar = createProbe({
        kind: 'demo.scalar',
        paramsSchema: z.object({}),
        eventSchema: z.string(),
      });
      await registry.register('demo', [assignment.type, scalar.type]);
      const listener = vi.fn<AutomationTriggerListener>();

      const prepared = runtime.prepareBinding({ kind: 'demo.scalar', params: {} });
      expect(prepared?.workflowCompatible).toBe(false);
      await prepared?.subscribe(listener);
      await scalar.emit('ping');

      expect(firstEvent(listener).payload).toBe('ping');
    });

    it('accepts schema input from typed emit and delivers transformed output', async () => {
      const transformed = toAutomationTriggerType(
        defineAutomationTrigger({
          kind: 'demo.transformed-event',
          label: 'Transformed event',
          description: 'Transforms emitted source values.',
          categories: ['test'],
          paramsSchema: z.object({}),
          eventSchema: z.codec(z.string(), z.object({ normalized: z.string() }), {
            decode: (value) => ({ normalized: value.toUpperCase() }),
            encode: (value) => value.normalized,
          }),
          activate: async (context) => {
            await context.emit('ping');
            return async () => undefined;
          },
        }),
      );
      await registry.register('demo', [assignment.type, transformed]);
      const listener = vi.fn<AutomationTriggerListener>();

      const prepared = runtime.prepareBinding({ kind: 'demo.transformed-event', params: {} });
      expect(prepared?.workflowCompatible).toBe(true);
      await prepared?.subscribe(listener);

      expect(firstEvent(listener).payload).toEqual({ normalized: 'PING' });
    });

    it('stamps the envelope and propagates the correlation id', async () => {
      const listener = vi.fn<AutomationTriggerListener>();
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, listener);

      const before = Date.now();
      await assignment.emit({ issueId: 'SHOP-1' }, { correlationId: 'trace-1' });

      const event = firstEvent(listener);
      expect(event.kind).toBe('demo.assignment');
      expect(event.payload).toEqual({ issueId: 'SHOP-1' });
      expect(event.correlationId).toBe('trace-1');
      expect(event.observedAt).toBeGreaterThanOrEqual(before);
    });

    it('omits the correlation id when the source does not supply one', async () => {
      const listener = vi.fn<AutomationTriggerListener>();
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, listener);

      await assignment.emit({ issueId: 'SHOP-1' });

      expect('correlationId' in firstEvent(listener)).toBe(false);
    });

    it('validates the payload before invoking any listener', async () => {
      const listener = vi.fn();
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, listener);

      await expect(assignment.emit({ issueId: 42 })).rejects.toThrow();
      expect(listener).not.toHaveBeenCalled();

      await assignment.emit({ issueId: 'SHOP-1' });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('isolates a failing listener from its siblings and keeps the source alive', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failing = vi.fn(() => {
        throw new Error('listener exploded');
      });
      const healthy = vi.fn();

      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, failing);
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, healthy);

      await expect(assignment.emit({ issueId: 'SHOP-1' })).resolves.toBeUndefined();
      expect(failing).toHaveBeenCalledTimes(1);
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();

      await assignment.emit({ issueId: 'SHOP-2' });
      expect(failing).toHaveBeenCalledTimes(2);
      expect(healthy).toHaveBeenCalledTimes(2);
    });

    it('ignores emits that arrive after the binding was cleaned up', async () => {
      const listener = vi.fn();
      const subscription = await runtime.subscribe(
        { kind: 'demo.assignment', params: { projectKey: 'shop' } },
        listener,
      );

      await subscription.detach();
      expect(assignment.cleanup).toHaveBeenCalledTimes(1);

      await expect(assignment.emit({ issueId: 'SHOP-1' })).resolves.toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
    });

    it('rejects a non-JSON payload that a permissive event schema admits', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      // `z.any()` parses a Date unchanged: the event schema alone cannot carry the
      // JSON guarantee that listeners and the bus rely on.
      const permissive = createProbe({
        kind: 'demo.permissive',
        paramsSchema: z.object({ id: z.string() }),
        eventSchema: z.any(),
      });
      await registry.register('demo', [assignment.type, permissive.type]);

      const listener = vi.fn();
      await runtime.subscribe({ kind: 'demo.permissive', params: { id: 'a' } }, listener);

      await expect(permissive.emit(new Date())).rejects.toThrow();
      expect(listener).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();

      await permissive.emit({ issueId: 'SHOP-1' });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not deliver to listeners of a superseded activation generation', async () => {
      const staleListener = vi.fn();
      const staleSubscription = await runtime.subscribe(
        { kind: 'demo.assignment', params: { projectKey: 'shop' } },
        staleListener,
      );
      const staleContext = latestContext(assignment);

      await staleSubscription.detach();

      const freshListener = vi.fn();
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, freshListener);

      await staleContext.emit({ issueId: 'SHOP-1' });
      expect(staleListener).not.toHaveBeenCalled();
      expect(freshListener).not.toHaveBeenCalled();

      await assignment.emit({ issueId: 'SHOP-2' });
      expect(freshListener).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Detach semantics
  // -------------------------------------------------------------------------

  describe('detach', () => {
    it('is idempotent', async () => {
      const subscription = await runtime.subscribe(
        { kind: 'demo.assignment', params: { projectKey: 'shop' } },
        vi.fn(),
      );

      await subscription.detach();
      await expect(subscription.detach()).resolves.toBeUndefined();
      expect(assignment.cleanup).toHaveBeenCalledTimes(1);
    });

    it('does not tear down a shared binding when one of two owners detaches twice', async () => {
      const survivor = vi.fn();
      const leaving = await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, vi.fn());
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, survivor);

      await leaving.detach();
      await leaving.detach();

      expect(assignment.cleanup).not.toHaveBeenCalled();
      await assignment.emit({ issueId: 'SHOP-1' });
      expect(survivor).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Activation failure isolation
  // -------------------------------------------------------------------------

  describe('activation failure', () => {
    it('propagates the failure to the subscriber without poisoning the lane', async () => {
      const failing = createProbe({
        kind: 'demo.failing',
        paramsSchema: z.object({ id: z.string() }),
        onActivate: () => {
          throw new Error('activation exploded');
        },
      });
      await registry.register('demo', [assignment.type, failing.type]);

      await expect(runtime.subscribe({ kind: 'demo.failing', params: { id: 'a' } }, vi.fn())).rejects.toThrow(
        'activation exploded',
      );

      const listener = vi.fn();
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, listener);
      await assignment.emit({ issueId: 'SHOP-1' });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not retain the failed binding for later subscribers', async () => {
      let shouldFail = true;
      const flaky = createProbe({
        kind: 'demo.flaky',
        paramsSchema: z.object({ id: z.string() }),
        onActivate: () => {
          if (shouldFail) {
            shouldFail = false;
            throw new Error('first activation exploded');
          }
        },
      });
      await registry.register('demo', [assignment.type, flaky.type]);

      await expect(runtime.subscribe({ kind: 'demo.flaky', params: { id: 'a' } }, vi.fn())).rejects.toThrow(
        'first activation exploded',
      );

      const listener = vi.fn();
      await runtime.subscribe({ kind: 'demo.flaky', params: { id: 'a' } }, listener);
      await flaky.emit({ issueId: 'x' });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(flaky.activate).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // stopOwner
  // -------------------------------------------------------------------------

  describe('stopOwner', () => {
    it('rejects a pending acquisition retired by the owner stop', async () => {
      const gate = createDeferred();
      const slow = createProbe({
        kind: 'demo.slow-owner',
        paramsSchema: z.object({ id: z.string() }),
        onActivate: () => gate.promise,
      });
      await registry.register('demo', [assignment.type, slow.type]);

      const pending = runtime.subscribe({ kind: 'demo.slow-owner', params: { id: 'a' } }, vi.fn());
      const rejected = expect(pending).rejects.toThrow(/acquisition.*retired/i);
      const stopping = runtime.stopOwner('demo');

      gate.resolve();

      await withinTimeout(rejected, 'acquisition retired by stopOwner');
      await withinTimeout(stopping, 'stopOwner during activation');
      expect(slow.cleanup).toHaveBeenCalledTimes(1);
    });

    it('cleans only the matching owner and leaves other owners emitting', async () => {
      const other = createProbe({
        kind: 'other.watch',
        paramsSchema: z.object({ id: z.string() }),
      });
      await registry.register('other', [other.type]);

      const demoListener = vi.fn();
      const otherListener = vi.fn();
      const demoSubscription = await runtime.subscribe(
        { kind: 'demo.assignment', params: { projectKey: 'shop' } },
        demoListener,
      );
      await runtime.subscribe({ kind: 'other.watch', params: { id: 'a' } }, otherListener);

      await runtime.stopOwner('demo');

      expect(assignment.cleanup).toHaveBeenCalledTimes(1);
      expect(other.cleanup).not.toHaveBeenCalled();

      await assignment.emit({ issueId: 'SHOP-1' });
      expect(demoListener).not.toHaveBeenCalled();

      await other.emit({ issueId: 'OTHER-1' });
      expect(otherListener).toHaveBeenCalledTimes(1);

      await expect(demoSubscription.detach()).resolves.toBeUndefined();
      expect(assignment.cleanup).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for an owner with no active bindings', async () => {
      await expect(runtime.stopOwner('nobody')).resolves.toBeUndefined();
    });

    it('allows the owner to be re-subscribed afterwards', async () => {
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, vi.fn());
      await runtime.stopOwner('demo');

      const listener = vi.fn();
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, listener);
      await assignment.emit({ issueId: 'SHOP-1' });

      expect(assignment.activate).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // stopKind
  // -------------------------------------------------------------------------

  describe('stopKind', () => {
    it('rejects a pending acquisition retired by the kind stop', async () => {
      const gate = createDeferred();
      const slow = createProbe({
        kind: 'demo.slow-kind',
        paramsSchema: z.object({ id: z.string() }),
        onActivate: () => gate.promise,
      });
      await registry.register('demo', [assignment.type, slow.type]);

      const pending = runtime.subscribe({ kind: 'demo.slow-kind', params: { id: 'a' } }, vi.fn());
      const rejected = expect(pending).rejects.toThrow(/acquisition.*retired/i);
      const stopping = runtime.stopKind('demo.slow-kind');

      gate.resolve();

      await withinTimeout(rejected, 'acquisition retired by stopKind');
      await withinTimeout(stopping, 'stopKind during activation');
      expect(slow.cleanup).toHaveBeenCalledTimes(1);
    });

    it('retires only the named kind and leaves the owner’s other kinds emitting', async () => {
      // The case this exists for: one of an owner's kinds is backed by a service
      // that went away, while its siblings are backed by something still live.
      const sibling = createProbe({
        kind: 'demo.watch',
        paramsSchema: z.object({ id: z.string() }),
      });
      await registry.register('demo', [assignment.type, sibling.type]);

      const assignmentListener = vi.fn();
      const siblingListener = vi.fn();
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, assignmentListener);
      await runtime.subscribe({ kind: 'demo.watch', params: { id: 'a' } }, siblingListener);

      await runtime.stopKind('demo.assignment');

      expect(assignment.cleanup).toHaveBeenCalledTimes(1);
      expect(sibling.cleanup).not.toHaveBeenCalled();

      await assignment.emit({ issueId: 'SHOP-1' });
      expect(assignmentListener).not.toHaveBeenCalled();

      await sibling.emit({ issueId: 'WATCH-1' });
      expect(siblingListener).toHaveBeenCalledTimes(1);
    });

    it('unindexes the activation so the next subscribe builds a fresh one', async () => {
      // The property the cron scheduler restart depends on: a retired activation
      // must not be joinable, or the next acquisition would attach to a source
      // whose backing service is already dead.
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, vi.fn());
      await runtime.stopKind('demo.assignment');

      const listener = vi.fn();
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, listener);

      expect(assignment.activate).toHaveBeenCalledTimes(2);
      await assignment.emit({ issueId: 'SHOP-1' });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('is a no-op for a kind with no active bindings', async () => {
      await expect(runtime.stopKind('demo.assignment')).resolves.toBeUndefined();
      await expect(runtime.stopKind('nobody.nothing')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Registration identity
  // -------------------------------------------------------------------------

  describe('registration identity', () => {
    it('activates the replacement implementation instead of joining the superseded activation', async () => {
      const params = { projectKey: 'shop' };
      const firstListener = vi.fn();
      const first = await runtime.subscribe({ kind: 'demo.assignment', params }, firstListener);

      // Whole-batch replacement of the same kind with a different implementation:
      // a different `activate` body and a different event schema.
      const replacement = createProbe({
        kind: 'demo.assignment',
        paramsSchema: AssignmentParamsSchema,
        eventSchema: z.object({ ticketRef: z.string() }),
      });
      await registry.register('demo', [replacement.type]);

      const secondListener = vi.fn();
      const second = await runtime.subscribe({ kind: 'demo.assignment', params }, secondListener);

      // Same canonical key, yet the second subscriber must not have joined v1.
      expect(second.bindingKey).toBe(first.bindingKey);
      expect(replacement.activate).toHaveBeenCalledTimes(1);
      expect(replacement.observedParams[0]).toEqual({ projectKey: 'SHOP', labels: [] });

      // The superseded activation was retired and its cleanup awaited before the
      // replacement subscription resolved.
      expect(assignment.cleanup).toHaveBeenCalledTimes(1);
      expect(latestContext(assignment).signal.aborted).toBe(true);

      // Delivery now runs the replacement's event schema only.
      await replacement.emit({ ticketRef: 'SHOP-1' });
      expect(firstEvent(secondListener).payload).toEqual({ ticketRef: 'SHOP-1' });

      // The superseded subscriber is silenced, not migrated: its consumer
      // re-acquires on `automation-triggers.changed`. Its handle stays safe.
      expect(firstListener).not.toHaveBeenCalled();
      await expect(assignment.emit({ issueId: 'SHOP-1' })).resolves.toBeUndefined();
      expect(firstListener).not.toHaveBeenCalled();
      await expect(first.detach()).resolves.toBeUndefined();
      expect(assignment.cleanup).toHaveBeenCalledTimes(1);

      await second.detach();
      expect(replacement.cleanup).toHaveBeenCalledTimes(1);
    });

    it('still shares one activation while the registration is unchanged', async () => {
      const first = await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, vi.fn());
      const second = await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'SHOP' } }, vi.fn());

      expect(assignment.activate).toHaveBeenCalledTimes(1);
      expect(assignment.cleanup).not.toHaveBeenCalled();

      await first.detach();
      await second.detach();
    });
  });

  // -------------------------------------------------------------------------
  // Binding key resolution
  // -------------------------------------------------------------------------

  describe('resolveBindingKey', () => {
    it('derives the key a subscription would activate under', async () => {
      const resolved = runtime.resolveBindingKey({ kind: 'demo.assignment', params: { projectKey: 'shop' } });
      const subscription = await runtime.subscribe(
        { kind: 'demo.assignment', params: { projectKey: 'shop' } },
        vi.fn(),
      );

      expect(resolved).toBe(subscription.bindingKey);
      // Resolution is inspection only — nothing is activated by it.
      expect(assignment.activate).toHaveBeenCalledTimes(1);

      await subscription.detach();
    });

    it('returns undefined for an unregistered kind and rejects invalid params', () => {
      expect(runtime.resolveBindingKey({ kind: 'nobody.nothing', params: {} })).toBeUndefined();
      expect(() => runtime.resolveBindingKey({ kind: 'demo.assignment', params: { projectKey: 7 } })).toThrow();
    });

    it('uses one transformed parameter snapshot for a prepared key and subscription', async () => {
      let parseCount = 0;
      const stateful = createProbe({
        kind: 'demo.stateful',
        paramsSchema: z.object({ value: z.string() }).transform(() => {
          parseCount += 1;
          return { value: `parsed-${parseCount}` };
        }),
      });
      await registry.register('demo', [assignment.type, stateful.type]);

      const prepared = runtime.prepareBinding({ kind: 'demo.stateful', params: { value: 'raw' } });
      if (prepared === undefined) throw new Error('Expected the registered binding to prepare');
      const subscription = await prepared.subscribe(vi.fn());

      expect(parseCount).toBe(1);
      expect(subscription.bindingKey).toBe('demo.stateful:{"value":"parsed-1"}');
      expect(stateful.observedParams).toEqual([{ value: 'parsed-1' }]);

      await subscription.detach();
    });
  });

  // -------------------------------------------------------------------------
  // Lane isolation — extension code must never hold the state-transition lane
  // -------------------------------------------------------------------------

  describe('lane isolation from extension code', () => {
    it('lets a listener re-enter the runtime during delivery of an activation-time emit', async () => {
      const emitting = createProbe({
        kind: 'demo.emitting',
        paramsSchema: z.object({ id: z.string() }),
        onActivate: async (context) => {
          await context.emit({ issueId: 'SHOP-1' });
        },
      });
      await registry.register('demo', [assignment.type, emitting.type]);

      const nestedListener = vi.fn();
      let nestedAttached = false;
      const reentrant = vi.fn(async () => {
        // Re-enters the runtime from inside delivery — exactly what the dispatch
        // contract advertises as safe. It deadlocked while the acquisition held
        // the lane across `activate`.
        await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, nestedListener);
        nestedAttached = true;
      });

      await withinTimeout(
        runtime.subscribe({ kind: 'demo.emitting', params: { id: 'a' } }, reentrant),
        'subscribe whose activation-time emit re-enters the runtime',
      );

      expect(reentrant).toHaveBeenCalledTimes(1);
      expect(nestedAttached).toBe(true);

      await assignment.emit({ issueId: 'SHOP-2' });
      expect(nestedListener).toHaveBeenCalledTimes(1);
    });

    it('closes an activation that only settles once its signal aborts and rejects the retired acquisition', async () => {
      const abortDriven = createProbe({
        kind: 'demo.abort-driven',
        paramsSchema: z.object({ id: z.string() }),
        onActivate: (context) =>
          new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => resolve(), { once: true });
          }),
      });
      await registry.register('demo', [assignment.type, abortDriven.type]);

      const pending = runtime.subscribe({ kind: 'demo.abort-driven', params: { id: 'a' } }, vi.fn());
      const rejected = expect(pending).rejects.toThrow(/acquisition.*retired/i);

      // The abort that unblocks the activation happens inside close's own
      // teardown: close must not be queued behind the activation it will abort.
      await withinTimeout(runtime.close(), 'close during an abort-driven activation');
      await withinTimeout(rejected, 'retired acquisition of an abort-driven activation');

      expect(abortDriven.cleanup).toHaveBeenCalledTimes(1);
    });

    it('disposes a binding whose cleanup awaits another runtime mutation', async () => {
      const collateralProbe = createProbe({
        kind: 'other.watch',
        paramsSchema: z.object({ id: z.string() }),
      });
      await registry.register('other', [collateralProbe.type]);
      const collateral = await runtime.subscribe({ kind: 'other.watch', params: { id: 'a' } }, vi.fn());

      const reentrantTeardown = createProbe({
        kind: 'demo.reentrant-teardown',
        paramsSchema: z.object({ id: z.string() }),
        onCleanup: () => collateral.detach(),
      });
      await registry.register('demo', [assignment.type, reentrantTeardown.type]);

      const subscription = await runtime.subscribe({ kind: 'demo.reentrant-teardown', params: { id: 'a' } }, vi.fn());

      await withinTimeout(subscription.detach(), 'detach whose cleanup re-enters the runtime');

      expect(reentrantTeardown.cleanup).toHaveBeenCalledTimes(1);
      expect(collateralProbe.cleanup).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  describe('close', () => {
    it('disposes every active binding and rejects later subscriptions', async () => {
      const other = createProbe({
        kind: 'other.watch',
        paramsSchema: z.object({ id: z.string() }),
      });
      await registry.register('other', [other.type]);
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, vi.fn());
      await runtime.subscribe({ kind: 'other.watch', params: { id: 'a' } }, vi.fn());

      await runtime.close();

      expect(assignment.cleanup).toHaveBeenCalledTimes(1);
      expect(other.cleanup).toHaveBeenCalledTimes(1);
      await expect(
        runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, vi.fn()),
      ).rejects.toThrow(/closed/i);
    });

    it('is idempotent', async () => {
      await runtime.subscribe({ kind: 'demo.assignment', params: { projectKey: 'shop' } }, vi.fn());

      await runtime.close();
      await expect(runtime.close()).resolves.toBeUndefined();
      expect(assignment.cleanup).toHaveBeenCalledTimes(1);
    });

    it('waits for a pending activation, disposes it, and rejects the retired acquisition', async () => {
      const gate = createDeferred();
      const slow = createProbe({
        kind: 'demo.slow',
        paramsSchema: z.object({ id: z.string() }),
        onActivate: () => gate.promise,
      });
      await registry.register('demo', [assignment.type, slow.type]);

      const listener = vi.fn();
      const pending = runtime.subscribe({ kind: 'demo.slow', params: { id: 'a' } }, listener);
      const rejected = expect(pending).rejects.toThrow(/acquisition.*retired/i);
      const closing = runtime.close();

      gate.resolve();
      await rejected;
      await closing;

      expect(slow.cleanup).toHaveBeenCalledTimes(1);
      await slow.emit({ issueId: 'x' });
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
