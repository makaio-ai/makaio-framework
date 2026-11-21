import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { MakaioBus } from '@makaio/bus-core';
import {
  AutomationTriggerSubjects,
  CRON_AUTOMATION_TRIGGER_KIND,
  CronAutomationTriggerParamsSchema,
  WorkflowSubjects,
  defineAutomationTrigger,
  toAutomationTriggerType,
} from '@makaio/contracts';
import {
  AUTOMATION_TRIGGER_BUILTINS_OWNER,
  AutomationTriggerBindingRuntime,
  AutomationTriggerRegistry,
} from '@makaio/services-core/automation-trigger';
import { WorkflowTriggerReconciler } from '../workflow-trigger-reconciler.js';
import { WorkflowStorageSubjects } from '../storage/namespace.js';
import {
  createTestDb,
  createWorkflowDefinition,
  type TestDbContext,
  type WorkflowDefinitionOptions,
} from './shared.js';

// ─────────────────────────────────────────────────────────────
// Test trigger source
//
// A real authored automation trigger — not a mock. It records every
// activation and cleanup so the tests can assert on canonical sharing and on
// acquire-before-release ordering, and it exposes an `emit` handle per live
// activation so a test can drive events without a real external source.
// ─────────────────────────────────────────────────────────────

/** Owner of the test-only trigger batch. */
const TEST_OWNER = 'test-source';

/** Canonical kind contributed by {@link TEST_OWNER}. */
const TEST_KIND = 'test-source.pulse';

/**
 * Second canonical kind contributed by {@link TEST_OWNER}, emitting a bare JSON
 * string. Generic automation consumers may subscribe to it, while workflow
 * consumers must leave it inactive.
 */
const TEST_SCALAR_KIND = 'test-source.scalar';

/**
 * Third canonical kind contributed by {@link TEST_OWNER}, emitting once from
 * inside `activate`.
 *
 * A source is free to deliver its first event before `activate` returns — a
 * catch-up read, a replayed backlog, a webhook that was already queued — so the
 * subscription handle does not exist yet when that event is dispatched. That is
 * the only window in which the reconciler's designation ordering is observable.
 */
const TEST_EAGER_KIND = 'test-source.eager';

/** Trigger kind whose stateful parameter transform exposes repeated parsing. */
const TEST_STATEFUL_KIND = 'test-source.stateful';

/**
 * Owner of a second, unrelated test-only trigger batch.
 *
 * A registry `changed` event carries exact affected kinds, so a second owner is
 * what makes changed-kind scoping observable.
 */
const OTHER_OWNER = 'other-source';

/** Canonical kind contributed by {@link OTHER_OWNER}. */
const OTHER_KIND = 'other-source.pulse';

/** Parent owner used to prove dotted owner names do not imply nested ownership. */
const OVERLAPPING_PARENT_OWNER = 'makaio';

/** Trigger kind owned by {@link OVERLAPPING_PARENT_OWNER}. */
const OVERLAPPING_PARENT_KIND = 'makaio.pulse';

/** Dot-qualified owner whose name starts with the parent owner's name. */
const OVERLAPPING_NESTED_OWNER = 'makaio.clients-core';

/** Trigger kind owned by {@link OVERLAPPING_NESTED_OWNER}. */
const OVERLAPPING_NESTED_KIND = 'makaio.clients-core.profile-changed';

/**
 * Creates the trigger type contributed by {@link OTHER_OWNER}.
 *
 * Deliberately featureless: tests using it assert on which bindings the
 * reconciler subscribes, not on what this source emits.
 * @returns The registry-boundary trigger type of the second owner.
 */
function createOtherOwnerType(): ReturnType<typeof toAutomationTriggerType> {
  return toAutomationTriggerType(
    defineAutomationTrigger({
      kind: OTHER_KIND,
      label: 'Other Pulse',
      description: 'Stands in for an unrelated owner in reconciler tests.',
      categories: ['Test'],
      paramsSchema: z.object({ channel: z.string().min(1) }),
      eventSchema: z.object({ value: z.number() }),
      activate: async () => () => undefined,
    }),
  );
}

/**
 * Creates one no-op trigger for exact changed-kind scoping tests.
 * @param kind - Canonical trigger kind to contribute.
 * @returns Registry-boundary trigger type for the supplied kind.
 */
function createScopedTriggerType(
  kind: typeof OVERLAPPING_PARENT_KIND | typeof OVERLAPPING_NESTED_KIND,
): ReturnType<typeof toAutomationTriggerType> {
  return toAutomationTriggerType(
    defineAutomationTrigger({
      kind,
      label: kind,
      description: 'Stands in for an overlapping owner in reconciler tests.',
      categories: ['Test'],
      paramsSchema: z.object({ channel: z.string().min(1) }),
      eventSchema: z.object({ value: z.number() }),
      activate: async () => () => undefined,
    }),
  );
}

/**
 * Creates a replacement for {@link TEST_KIND} whose parameter contract rejects
 * the string-shaped bindings accepted by the original registration.
 * @returns A registry-boundary trigger type with the changed schema.
 */
function createSchemaChangedTestType(): ReturnType<typeof toAutomationTriggerType> {
  return toAutomationTriggerType(
    defineAutomationTrigger({
      kind: TEST_KIND,
      label: 'Schema Changed Test Pulse',
      description: 'Rejects the original test trigger parameters after owner replacement.',
      categories: ['Test'],
      paramsSchema: z.object({ channel: z.number() }),
      eventSchema: z.object({ channel: z.string(), value: z.number() }),
      activate: async () => () => undefined,
    }),
  );
}

/** Payload shape emitted by the test trigger. */
interface TestEvent {
  /** Channel the emitting activation was bound to. */
  readonly channel: string;
  /** Numeric field the consumer filters on. */
  readonly value: number;
}

/** One lifecycle event recorded by the test trigger. */
type LifecycleEvent = `activate:${string}` | `cleanup:${string}`;

/** Live activation handle exposed to the driving test. */
interface LiveActivation {
  /** `channel` parameter this activation was created for. */
  readonly channel: string;
  /** Emits one payload through the activation context. */
  readonly emit: (payload: TestEvent | string) => Promise<void>;
}

/**
 * A cleanup a test holds open.
 *
 * Cleanup is extension-owned and may take arbitrarily long, which is what makes
 * the window between releasing a superseded subscription and completing its
 * teardown observable at all.
 */
interface CleanupGate {
  /** Resolved by the source once the gated cleanup has been entered. */
  readonly entered: PromiseWithResolvers<void>;
  /** Awaited by the gated cleanup before it completes. */
  readonly release: Promise<void>;
}

/** Observable state of the test trigger source. */
interface TestSource {
  /** Ordered activate/cleanup log used for ordering assertions. */
  readonly lifecycle: LifecycleEvent[];
  /** Currently live activations, in activation order. */
  readonly live: LiveActivation[];
  /** Cleanups a test holds open, keyed by channel. */
  readonly cleanupGates: Map<string, CleanupGate>;
  /** Registry-boundary trigger types to contribute. */
  readonly types: readonly ReturnType<typeof toAutomationTriggerType>[];
  /** Observable stand-in for the built-in cron trigger type. */
  readonly cronType: ReturnType<typeof toAutomationTriggerType>;
}

/**
 * Creates the test trigger source.
 * @returns An observable source plus its contributable trigger types.
 */
function createTestSource(): TestSource {
  const lifecycle: LifecycleEvent[] = [];
  const live: LiveActivation[] = [];
  const cleanupGates = new Map<string, CleanupGate>();

  /**
   * Shared activation body of every kind this source contributes.
   * @param emit - Emitter of the activating kind, accepting the payload shapes a
   *   test may drive it with.
   * @param channel - `channel` parameter of the activating binding.
   * @returns The activation's cleanup.
   */
  const activateChannel = (
    emit: (payload: TestEvent | string) => Promise<void>,
    channel: string,
  ): (() => Promise<void>) => {
    lifecycle.push(`activate:${channel}`);
    const entry: LiveActivation = { channel, emit };
    live.push(entry);

    return async () => {
      lifecycle.push(`cleanup:${channel}`);
      const index = live.indexOf(entry);
      if (index !== -1) live.splice(index, 1);

      const gate = cleanupGates.get(channel);
      if (gate === undefined) return;
      gate.entered.resolve();
      await gate.release;
    };
  };

  const type = toAutomationTriggerType(
    defineAutomationTrigger({
      kind: TEST_KIND,
      label: 'Test Pulse',
      description: 'Emits payloads on demand for reconciler tests.',
      categories: ['Test'],
      paramsSchema: z.object({ channel: z.string().min(1) }),
      eventSchema: z.object({ channel: z.string(), value: z.number() }),
      activate: async (context, params) => {
        if (params.channel === 'reject') throw new Error('test activation rejected');
        return activateChannel(async (payload) => {
          if (typeof payload === 'string') throw new Error(`${TEST_KIND} emits objects, not strings`);
          await context.emit(payload);
        }, params.channel);
      },
    }),
  );

  const scalarType = toAutomationTriggerType(
    defineAutomationTrigger({
      kind: TEST_SCALAR_KIND,
      label: 'Test Scalar Pulse',
      description: 'Emits bare JSON strings on demand for reconciler tests.',
      categories: ['Test'],
      paramsSchema: z.object({ channel: z.string().min(1) }),
      eventSchema: z.string(),
      activate: async (context, params) =>
        activateChannel(async (payload) => {
          if (typeof payload !== 'string') throw new Error(`${TEST_SCALAR_KIND} emits strings, not objects`);
          await context.emit(payload);
        }, params.channel),
    }),
  );

  const eagerType = toAutomationTriggerType(
    defineAutomationTrigger({
      kind: TEST_EAGER_KIND,
      label: 'Test Eager Pulse',
      description: 'Emits one payload from inside activate for reconciler tests.',
      categories: ['Test'],
      paramsSchema: z.object({ channel: z.string().min(1) }),
      eventSchema: z.object({ channel: z.string(), value: z.number() }),
      activate: async (context, params) => {
        const cleanup = activateChannel(async (payload) => {
          if (typeof payload === 'string') throw new Error(`${TEST_EAGER_KIND} emits objects, not strings`);
          await context.emit(payload);
        }, params.channel);

        // Emitted before `activate` resolves, so no subscription handle exists yet.
        await context.emit({ channel: params.channel, value: 0 });
        return cleanup;
      },
    }),
  );

  const cronType = toAutomationTriggerType(
    defineAutomationTrigger({
      kind: CRON_AUTOMATION_TRIGGER_KIND,
      label: 'Test Cron',
      description: 'Observable stand-in for global-scope cron eligibility tests.',
      categories: ['Test'],
      paramsSchema: CronAutomationTriggerParamsSchema,
      eventSchema: z.object({ channel: z.string(), value: z.number() }),
      activate: async (context, params) =>
        activateChannel(async (payload) => {
          if (typeof payload === 'string') {
            throw new Error(`${CRON_AUTOMATION_TRIGGER_KIND} emits objects, not strings`);
          }
          await context.emit(payload);
        }, params.schedule),
    }),
  );

  return { lifecycle, live, cleanupGates, types: [type, scalarType, eagerType], cronType };
}

/**
 * Emits one payload on the single live activation of a channel.
 * @param source - Test trigger source.
 * @param channel - Channel whose activation should emit.
 * @param payload - Payload to emit.
 * @returns Resolves once every listener has settled.
 */
async function emitOn(source: TestSource, channel: string, payload: TestEvent | string): Promise<void> {
  const activations = source.live.filter((entry) => entry.channel === channel);
  expect(activations).toHaveLength(1);
  await activations[0].emit(payload);
}

// ─────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────

/**
 * Persisted bindings that still carry a removed trigger filter key.
 *
 * Declared as plain objects so they reach storage without a cast: the binding
 * type no longer admits these keys, but stored rows from before the change can.
 */
const legacyBindings = {
  filter: { kind: TEST_KIND, params: { channel: 'legacy' }, filter: { value: 1 } },
  filterExpression: { kind: TEST_KIND, params: { channel: 'legacy' }, filterExpression: 'payload.value > 1' },
};

/** `when` that names a payload field no test trigger emits. */
const UNFIT_WHEN = { field: 'payload.missing', operator: 1 } as const;

/** Captured `WorkflowSubjects.start` request. */
interface CapturedStart {
  /** Workflow the reconciler asked to start. */
  workflowId: string;
  /** Trigger payload forwarded from the automation trigger event. */
  triggerPayload: Record<string, unknown> | undefined;
}

describe('WorkflowTriggerReconciler', () => {
  let dbContext: TestDbContext;
  let registry: AutomationTriggerRegistry;
  let runtime: AutomationTriggerBindingRuntime;
  /**
   * Runtime the reconciler's resolver reports.
   *
   * Reassignable because the binding runtime is a restartable package: the
   * reconciler resolves it per reconciliation rather than capturing it, and a test
   * swaps this to stand in for that restart.
   */
  let resolvedRuntime: AutomationTriggerBindingRuntime | undefined;
  let reconciler: WorkflowTriggerReconciler;
  let source: TestSource;
  let starts: CapturedStart[];
  let cleanupFns: Array<() => void>;

  beforeEach(async () => {
    MakaioBus.__resetHandlers?.();
    starts = [];
    cleanupFns = [];
    dbContext = await createTestDb();

    cleanupFns.push(
      MakaioBus.on(WorkflowSubjects.start, (ctx) => {
        starts.push({ workflowId: ctx.payload.workflowId, triggerPayload: ctx.payload.triggerPayload });
        ctx.setResult({ executionId: `exec-${starts.length}` });
      }),
    );

    registry = new AutomationTriggerRegistry(MakaioBus);
    await registry.init();
    runtime = new AutomationTriggerBindingRuntime({
      resolveRegistration: (kind) => registry.resolveRegistration(kind),
    });
    resolvedRuntime = runtime;
    source = createTestSource();
    await registry.register(TEST_OWNER, source.types);
    await registry.register(AUTOMATION_TRIGGER_BUILTINS_OWNER, [source.cronType]);

    reconciler = new WorkflowTriggerReconciler(MakaioBus, () => resolvedRuntime);
  });

  afterEach(async () => {
    await reconciler.destroy();
    await runtime.close();
    await registry.destroy();
    cleanupFns.forEach((fn) => fn());
    dbContext.cleanup();
    MakaioBus.__resetHandlers?.();
  });

  /**
   * Persists a workflow definition through the storage handlers.
   * @param id - Workflow identifier.
   * @param triggers - Declarative trigger bindings to persist.
   * @returns Resolves once the definition is stored.
   */
  async function store(id: string, triggers: WorkflowDefinitionOptions['triggers']): Promise<void> {
    await MakaioBus.request(WorkflowStorageSubjects.set, {
      workflow: createWorkflowDefinition({ id, triggers }),
    });
  }

  it('shares one activation between two workflows and starts them independently', async () => {
    await store('wf-alpha', [
      { kind: TEST_KIND, params: { channel: 'main' }, when: { field: 'payload.value', operator: { $in: [1, 2] } } },
    ]);
    await store('wf-beta', [{ kind: TEST_KIND, params: { channel: 'main' }, when: { $expr: 'payload.value > 5' } }]);

    await reconciler.init();

    // Canonical sharing: two bindings with equal parsed params activate once.
    expect(source.lifecycle).toEqual(['activate:main']);
    expect(reconciler.activeConsumerCount()).toBe(2);

    await emitOn(source, 'main', { channel: 'main', value: 1 });
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toEqual({
      workflowId: 'wf-alpha',
      triggerPayload: { channel: 'main', value: 1 },
    });

    await emitOn(source, 'main', { channel: 'main', value: 9 });
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]).toEqual({
      workflowId: 'wf-beta',
      triggerPayload: { channel: 'main', value: 9 },
    });
  });

  it('keeps global cron inactive while consuming another global trigger kind', async () => {
    await store('wf-global-kinds', [
      { kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '* * * * *' } },
      { kind: TEST_KIND, params: { channel: 'global-event' } },
    ]);

    await reconciler.init();

    expect(reconciler.activeConsumerCount()).toBe(1);
    expect(source.lifecycle).toEqual(['activate:global-event']);

    await emitOn(source, 'global-event', { channel: 'global-event', value: 1 });
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]?.workflowId).toBe('wf-global-kinds');
  });

  it('detaches cron on external-to-global scope changes and acquires it on the reverse transition', async () => {
    const triggers = [{ kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '* * * * *' } }];
    const external = createWorkflowDefinition({
      id: 'wf-cron-scope-transition',
      scope: { type: 'external', kind: 'project', id: 'project-1' },
      triggers,
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: external });
    await reconciler.init();

    expect(reconciler.activeConsumerCount()).toBe(1);
    expect(source.lifecycle).toEqual(['activate:* * * * *']);

    const global = createWorkflowDefinition({ id: external.id, scope: { type: 'global' }, triggers });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: global });
    resolvedRuntime = undefined;
    await MakaioBus.emit(WorkflowSubjects.definition.updated, global);
    await vi.waitFor(() => {
      expect(reconciler.activeConsumerCount()).toBe(0);
      expect(source.lifecycle).toHaveLength(2);
    });
    expect(source.lifecycle).toEqual(['activate:* * * * *', 'cleanup:* * * * *']);

    resolvedRuntime = runtime;
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: external });
    await MakaioBus.emit(WorkflowSubjects.definition.updated, external);
    await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(1));
    expect(source.lifecycle).toEqual(['activate:* * * * *', 'cleanup:* * * * *', 'activate:* * * * *']);
  });

  it('acquires the replacement binding before releasing the previous one', async () => {
    await store('wf-refresh', [{ kind: TEST_KIND, params: { channel: 'before' } }]);
    await reconciler.init();
    expect(source.lifecycle).toEqual(['activate:before']);

    const updated = createWorkflowDefinition({
      id: 'wf-refresh',
      triggers: [{ kind: TEST_KIND, params: { channel: 'after' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: updated });
    await MakaioBus.emit(WorkflowSubjects.definition.updated, updated);

    await vi.waitFor(() => expect(source.lifecycle).toHaveLength(3));
    expect(source.lifecycle).toEqual(['activate:before', 'activate:after', 'cleanup:before']);

    await emitOn(source, 'after', { channel: 'after', value: 3 });
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]?.workflowId).toBe('wf-refresh');
  });

  it('starts the workflow through the replacement while the superseded subscription is still cleaning up', async () => {
    await store('wf-handover', [{ kind: TEST_KIND, params: { channel: 'outgoing' } }]);
    await reconciler.init();
    expect(source.lifecycle).toEqual(['activate:outgoing']);

    // The outgoing activation's cleanup is extension-owned and held open here.
    // Between the moment its listener stops receiving events and the moment that
    // cleanup settles, the replacement is the only listener left — so it must
    // already be the designated one, or the event below reaches nobody.
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    source.cleanupGates.set('outgoing', { entered, release: release.promise });

    try {
      const updated = createWorkflowDefinition({
        id: 'wf-handover',
        triggers: [{ kind: TEST_KIND, params: { channel: 'incoming' } }],
      });
      await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: updated });
      await MakaioBus.emit(WorkflowSubjects.definition.updated, updated);

      await entered.promise;
      await emitOn(source, 'incoming', { channel: 'incoming', value: 4 });

      await vi.waitFor(() => expect(starts).toHaveLength(1));
      expect(starts[0]).toEqual({ workflowId: 'wf-handover', triggerPayload: { channel: 'incoming', value: 4 } });
    } finally {
      release.resolve();
    }

    // Exactly one start, and the handover completes: the outgoing activation is
    // gone once its cleanup settles.
    await vi.waitFor(() =>
      expect(source.lifecycle).toEqual(['activate:outgoing', 'activate:incoming', 'cleanup:outgoing']),
    );
    expect(starts).toHaveLength(1);
  });

  it('starts the workflow for an event the replacement source emits inside activate', async () => {
    await store('wf-eager', [{ kind: TEST_KIND, params: { channel: 'outgoing' } }]);
    await reconciler.init();
    expect(source.lifecycle).toEqual(['activate:outgoing']);
    expect(starts).toEqual([]);

    // The replacement targets a different activation than the binding it replaces,
    // so the still-attached outgoing listener cannot cover this event: it is not on
    // the new activation at all. Unless the incoming record is designated before
    // `subscribe`, the event the new source emits inside `activate` reaches an
    // undesignated listener and is dropped with nothing left to redeliver it.
    const updated = createWorkflowDefinition({
      id: 'wf-eager',
      triggers: [{ kind: TEST_EAGER_KIND, params: { channel: 'incoming' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: updated });
    await MakaioBus.emit(WorkflowSubjects.definition.updated, updated);

    await vi.waitFor(() =>
      expect(source.lifecycle).toEqual(['activate:outgoing', 'activate:incoming', 'cleanup:outgoing']),
    );

    // Exactly one start, from the new designation.
    expect(starts).toEqual([{ workflowId: 'wf-eager', triggerPayload: { channel: 'incoming', value: 0 } }]);
  });

  it('parses a binding once and designates its synchronous replacement event by the prepared key', async () => {
    let parseCount = 0;
    const parsedChannels = ['initial', 'live', 'live', 'next'] as const;
    const activations: string[] = [];
    const statefulType = toAutomationTriggerType(
      defineAutomationTrigger({
        kind: TEST_STATEFUL_KIND,
        label: 'Stateful Test Pulse',
        description: 'Uses a stateful transform to verify single-parse admission.',
        categories: ['Test'],
        paramsSchema: z.object({ channel: z.string() }).transform(() => {
          const channel = parsedChannels.at(Math.min(parseCount, parsedChannels.length - 1)) ?? 'next';
          parseCount += 1;
          return { channel };
        }),
        eventSchema: z.object({ channel: z.string(), value: z.number() }),
        activate: async (context, params) => {
          activations.push(params.channel);
          await context.emit({ channel: params.channel, value: 0 });
          return () => undefined;
        },
      }),
    );
    await registry.register(TEST_OWNER, [...source.types, statefulType]);
    const definition = createWorkflowDefinition({
      id: 'wf-stateful-parse',
      triggers: [{ kind: TEST_STATEFUL_KIND, params: { channel: 'raw' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });

    await reconciler.init();
    await vi.waitFor(() => expect(starts).toHaveLength(1));

    await MakaioBus.emit(WorkflowSubjects.definition.updated, definition);
    await vi.waitFor(() => expect(starts).toHaveLength(2));

    expect(parseCount).toBe(2);
    expect(activations).toEqual(['initial', 'live']);
    expect(starts).toEqual([
      { workflowId: definition.id, triggerPayload: { channel: 'initial', value: 0 } },
      { workflowId: definition.id, triggerPayload: { channel: 'live', value: 0 } },
    ]);
  });

  it('keeps an unchanged binding on its shared activation across a refresh', async () => {
    await store('wf-steady', [{ kind: TEST_EAGER_KIND, params: { channel: 'steady' } }]);
    await reconciler.init();
    expect(source.lifecycle).toEqual(['activate:steady']);
    await vi.waitFor(() => expect(starts).toHaveLength(1));

    // Index 0 is canonically identical to what is already live; index 1 is new, and
    // its activation is the deterministic signal that the refresh processed both.
    const updated = createWorkflowDefinition({
      id: 'wf-steady',
      triggers: [
        { kind: TEST_EAGER_KIND, params: { channel: 'steady' } },
        { kind: TEST_KIND, params: { channel: 'probe' } },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: updated });
    await MakaioBus.emit(WorkflowSubjects.definition.updated, updated);

    await vi.waitFor(() => expect(source.lifecycle).toContain('activate:probe'));

    // The unchanged consumer joined the activation it already held: no
    // re-activation, no teardown, and so no second activation-time emit. Had it
    // been designated early instead, the outgoing listener would have stopped
    // covering the shared source for the duration of the acquisition.
    expect(source.lifecycle).toEqual(['activate:steady', 'activate:probe']);
    expect(starts).toHaveLength(1);
    expect(reconciler.activeConsumerCount()).toBe(2);
  });

  it('re-subscribes on a restarted binding runtime and releases the handle the old one issued', async () => {
    await store('wf-restart', [{ kind: TEST_KIND, params: { channel: 'restart' } }]);
    await reconciler.init();
    expect(reconciler.activeConsumerCount()).toBe(1);

    // Binding-runtime package restart: the old instance closes, taking its
    // activations with it, and a fresh instance resolves against the same
    // registry. The handles the reconciler holds were issued by the closed
    // instance and are dead to the new one.
    const restarted = new AutomationTriggerBindingRuntime({
      resolveRegistration: (kind) => registry.resolveRegistration(kind),
    });
    resolvedRuntime = restarted;
    await runtime.close();
    expect(source.live).toHaveLength(0);

    try {
      // Contributor replay after a runtime restart re-registers the batch, which
      // is the `changed` signal reaching the reconciler here.
      await registry.register(TEST_OWNER, source.types);

      await vi.waitFor(() => expect(source.live).toHaveLength(1));
      expect(reconciler.activeConsumerCount()).toBe(1);

      await emitOn(source, 'restart', { channel: 'restart', value: 11 });
      await vi.waitFor(() => expect(starts).toHaveLength(1));
      expect(starts[0]).toEqual({ workflowId: 'wf-restart', triggerPayload: { channel: 'restart', value: 11 } });
    } finally {
      await reconciler.destroy();
      await restarted.close();
    }
  });

  it('leaves a persisted scalar-output binding inactive without activating its source', async () => {
    await store('wf-scalar', [
      { kind: TEST_SCALAR_KIND, params: { channel: 'scalar' }, when: { $expr: 'payload == "fire"' } },
    ]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await reconciler.init();

      expect(reconciler.activeConsumerCount()).toBe(0);
      expect(source.live).toHaveLength(0);
      expect(starts).toHaveLength(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('keeping last-good trigger'), expect.anything());
    } finally {
      error.mockRestore();
    }
  });

  it('drops an object subscription when its registration becomes scalar and restores it on object replay', async () => {
    await store('wf-compat-replay', [{ kind: TEST_KIND, params: { channel: 'compat' } }]);
    await reconciler.init();
    expect(source.lifecycle).toEqual(['activate:compat']);

    const scalarReplacement = toAutomationTriggerType(
      defineAutomationTrigger({
        kind: TEST_KIND,
        label: 'Scalar replacement',
        description: 'Temporarily makes the persisted binding workflow-incompatible.',
        categories: ['Test'],
        paramsSchema: z.object({ channel: z.string().min(1) }),
        eventSchema: z.string(),
        activate: async () => {
          throw new Error('A workflow-incompatible source must not activate');
        },
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await registry.register(TEST_OWNER, [scalarReplacement]);
      await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(0));
      expect(source.lifecycle).toEqual(['activate:compat', 'cleanup:compat']);

      await registry.register(TEST_OWNER, source.types);
      await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(1));
      expect(source.lifecycle).toEqual(['activate:compat', 'cleanup:compat', 'activate:compat']);

      await emitOn(source, 'compat', { channel: 'compat', value: 4 });
      await vi.waitFor(() => expect(starts).toHaveLength(1));
      expect(starts[0]).toEqual({ workflowId: 'wf-compat-replay', triggerPayload: { channel: 'compat', value: 4 } });
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps last-good subscriptions when a definition refresh carries an invalid binding', async () => {
    await store('wf-guard', [{ kind: TEST_KIND, params: { channel: 'good' } }]);
    await reconciler.init();
    expect(source.lifecycle).toEqual(['activate:good']);

    // A binding that fails schema parsing (here the removed `filterExpression`
    // key) invalidates the whole refresh: the workflow keeps the subscriptions it already had. The broken
    // definition is persisted first, because the refresh reads storage rather
    // than trusting the event payload.
    const broken = createWorkflowDefinition({
      id: 'wf-guard',
      triggers: [legacyBindings.filterExpression],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: broken });
    await MakaioBus.emit(WorkflowSubjects.definition.updated, broken);

    await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(1));
    expect(source.lifecycle).toEqual(['activate:good']);

    await emitOn(source, 'good', { channel: 'good', value: 1 });
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]?.workflowId).toBe('wf-guard');
  });

  it('activates valid persisted siblings when a cold-start binding carries a removed filter key', async () => {
    await store('wf-cold-invalid-sibling', [legacyBindings.filter, { kind: TEST_KIND, params: { channel: 'valid' } }]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await reconciler.init();

      expect(reconciler.activeConsumerCount()).toBe(1);
      expect(source.lifecycle).toEqual(['activate:valid']);
      await emitOn(source, 'valid', { channel: 'valid', value: 1 });
      await vi.waitFor(() => expect(starts).toHaveLength(1));
      expect(starts[0]?.workflowId).toBe('wf-cold-invalid-sibling');
    } finally {
      error.mockRestore();
    }
  });

  it('restores the designated last-good listener once when a valid replacement activation rejects', async () => {
    await store('wf-rejected-replacement', [{ kind: TEST_KIND, params: { channel: 'good' } }]);
    await reconciler.init();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const rejected = createWorkflowDefinition({
        id: 'wf-rejected-replacement',
        triggers: [{ kind: TEST_KIND, params: { channel: 'reject' } }],
      });
      await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: rejected });
      await MakaioBus.emit(WorkflowSubjects.definition.updated, rejected);

      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      expect(reconciler.activeConsumerCount()).toBe(1);
      expect(source.lifecycle).toEqual(['activate:good']);
      expect(source.live.map(({ channel }) => channel)).toEqual(['good']);

      await emitOn(source, 'good', { channel: 'good', value: 1 });
      await vi.waitFor(() =>
        expect(starts).toEqual([
          { workflowId: 'wf-rejected-replacement', triggerPayload: { channel: 'good', value: 1 } },
        ]),
      );
    } finally {
      error.mockRestore();
    }
  });

  describe('trigger binding condition', () => {
    it('starts the workflow only for events the `when` condition matches', async () => {
      await store('wf-when', [
        { kind: TEST_KIND, params: { channel: 'when' }, when: { field: 'payload.value', operator: { $gte: 5 } } },
      ]);
      await reconciler.init();
      expect(reconciler.activeConsumerCount()).toBe(1);

      await emitOn(source, 'when', { channel: 'when', value: 1 });
      expect(starts).toHaveLength(0);

      await emitOn(source, 'when', { channel: 'when', value: 9 });
      await vi.waitFor(() => expect(starts).toHaveLength(1));
      expect(starts[0]).toEqual({ workflowId: 'wf-when', triggerPayload: { channel: 'when', value: 9 } });
    });

    it('reports a run-time evaluation error once with the consumer identity and keeps handling events', async () => {
      // Compiles, so the schema check only warns; it fails at run time for large values.
      await store('wf-runtime-error', [
        {
          kind: TEST_KIND,
          params: { channel: 'rt' },
          when: { $expr: "payload.value > 5 ? '{bad'|parseJson : true" },
        },
      ]);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        await reconciler.init();
        expect(reconciler.activeConsumerCount()).toBe(1);

        await emitOn(source, 'rt', { channel: 'rt', value: 9 });

        expect(starts).toHaveLength(0);
        expect(error).toHaveBeenCalledTimes(1);
        const [message] = error.mock.calls[0] ?? [];
        expect(message).toEqual(expect.stringContaining('condition evaluation failed'));
        expect(message).toEqual(expect.stringContaining(`trigger 0 ('${TEST_KIND}') of workflow "wf-runtime-error"`));
        expect(message).toEqual(expect.stringContaining("'$expr'"));

        await emitOn(source, 'rt', { channel: 'rt', value: 1 });
        await vi.waitFor(() => expect(starts).toHaveLength(1));
        expect(starts[0]).toEqual({ workflowId: 'wf-runtime-error', triggerPayload: { channel: 'rt', value: 1 } });
        expect(error).toHaveBeenCalledTimes(1);
      } finally {
        error.mockRestore();
      }
    });

    it('installs no listener on a cold start when `when` does not fit the event schema', async () => {
      await store('wf-cold-unfit', [{ kind: TEST_KIND, params: { channel: 'unfit' }, when: UNFIT_WHEN }]);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        await reconciler.init();

        expect(reconciler.activeConsumerCount()).toBe(0);
        expect(source.live).toHaveLength(0);
        expect(source.lifecycle).toEqual([]);
        // The condition is checked once the event schema is known, not while parsing.
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('keeping last-good trigger 0'),
          expect.objectContaining({ message: expect.stringContaining('does not fit the event schema') }),
        );
        expect(error).not.toHaveBeenCalledWith(expect.stringContaining('leaving invalid trigger'), expect.anything());
      } finally {
        error.mockRestore();
      }
    });

    it('keeps the last-good listener when a refresh brings a `when` that does not fit the event schema', async () => {
      await store('wf-refresh-unfit', [{ kind: TEST_KIND, params: { channel: 'good' } }]);
      await reconciler.init();
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      try {
        const unfit = createWorkflowDefinition({
          id: 'wf-refresh-unfit',
          triggers: [{ kind: TEST_KIND, params: { channel: 'next' }, when: UNFIT_WHEN }],
        });
        await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: unfit });
        await MakaioBus.emit(WorkflowSubjects.definition.updated, unfit);

        await vi.waitFor(() =>
          expect(error).toHaveBeenCalledWith(
            expect.stringContaining('keeping last-good triggers for workflow'),
            expect.anything(),
          ),
        );
        expect(reconciler.activeConsumerCount()).toBe(1);
        expect(source.lifecycle).toEqual(['activate:good']);

        await emitOn(source, 'good', { channel: 'good', value: 1 });
        await vi.waitFor(() => expect(starts).toHaveLength(1));
        expect(starts[0]?.workflowId).toBe('wf-refresh-unfit');
      } finally {
        error.mockRestore();
      }
    });

    describe('a refresh with live consumers is batch-atomic for conditions', () => {
      /**
       * Stores `before`, starts the reconciler, stores and announces `after`, and
       * waits for the batch rejection log.
       * @param id - Workflow identifier.
       * @param before - Triggers live before the refresh.
       * @param after - Triggers of the refreshed definition.
       * @returns Resolves once the reconciler has logged the rejection.
       */
      async function refreshExpectingRejection(
        id: string,
        before: WorkflowDefinitionOptions['triggers'],
        after: WorkflowDefinitionOptions['triggers'],
      ): Promise<void> {
        await store(id, before);
        await reconciler.init();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
          const next = createWorkflowDefinition({ id, triggers: after });
          await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: next });
          await MakaioBus.emit(WorkflowSubjects.definition.updated, next);
          await vi.waitFor(() =>
            expect(error).toHaveBeenCalledWith(
              expect.stringContaining('keeping last-good triggers for workflow'),
              expect.anything(),
            ),
          );
          const batchLogs = error.mock.calls.filter(([message]) =>
            String(message).includes('keeping last-good triggers for workflow'),
          );
          expect(batchLogs).toHaveLength(1);
        } finally {
          error.mockRestore();
        }
      }

      it('touches no consumer when a later binding has an unfit `when`', async () => {
        await refreshExpectingRejection(
          'wf-batch-unfit',
          [
            { kind: TEST_KIND, params: { channel: 'a' } },
            { kind: TEST_KIND, params: { channel: 'b' } },
          ],
          [
            { kind: TEST_KIND, params: { channel: 'a2' } },
            { kind: TEST_KIND, params: { channel: 'b' }, when: UNFIT_WHEN },
          ],
        );

        expect(source.lifecycle).toEqual(['activate:a', 'activate:b']);
        expect(reconciler.activeConsumerCount()).toBe(2);
        await emitOn(source, 'a', { channel: 'a', value: 1 });
        await vi.waitFor(() => expect(starts).toHaveLength(1));
        expect(starts[0]?.workflowId).toBe('wf-batch-unfit');
      });

      it('does not release a removed binding when another binding is unfit', async () => {
        await refreshExpectingRejection(
          'wf-batch-removal',
          [
            { kind: TEST_KIND, params: { channel: 'a' } },
            { kind: TEST_KIND, params: { channel: 'b' } },
            { kind: TEST_KIND, params: { channel: 'c' } },
          ],
          [
            { kind: TEST_KIND, params: { channel: 'a' } },
            { kind: TEST_KIND, params: { channel: 'b' }, when: UNFIT_WHEN },
          ],
        );

        expect(source.lifecycle).toEqual(['activate:a', 'activate:b', 'activate:c']);
        expect(reconciler.activeConsumerCount()).toBe(3);
      });

      it('touches no consumer when a later binding has an `$expr` syntax error', async () => {
        await refreshExpectingRejection(
          'wf-batch-syntax',
          [
            { kind: TEST_KIND, params: { channel: 'a' } },
            { kind: TEST_KIND, params: { channel: 'b' } },
          ],
          [
            { kind: TEST_KIND, params: { channel: 'a2' } },
            { kind: TEST_KIND, params: { channel: 'b' }, when: { $expr: 'payload.value >' } },
          ],
        );

        expect(source.lifecycle).toEqual(['activate:a', 'activate:b']);
        expect(reconciler.activeConsumerCount()).toBe(2);
        await emitOn(source, 'a', { channel: 'a', value: 1 });
        await vi.waitFor(() => expect(starts).toHaveLength(1));
      });
    });

    it('does not block activation on warning findings', async () => {
      await store('wf-warning', [
        { kind: TEST_KIND, params: { channel: 'warn' }, when: { $expr: 'payload.value > 1' } },
      ]);
      await reconciler.init();

      expect(reconciler.activeConsumerCount()).toBe(1);
      await emitOn(source, 'warn', { channel: 'warn', value: 2 });
      await vi.waitFor(() => expect(starts).toHaveLength(1));
    });

    it('drops the consumer when a registry change makes its `when` unfit for the event schema', async () => {
      await store('wf-drop-unfit', [
        { kind: TEST_KIND, params: { channel: 'drop' }, when: { field: 'payload.value', operator: { $gte: 1 } } },
      ]);
      await reconciler.init();
      expect(source.lifecycle).toEqual(['activate:drop']);

      const narrowed = toAutomationTriggerType(
        defineAutomationTrigger({
          kind: TEST_KIND,
          label: 'Narrowed Test Pulse',
          description: 'Stops emitting the field the persisted condition reads.',
          categories: ['Test'],
          paramsSchema: z.object({ channel: z.string().min(1) }),
          eventSchema: z.object({ channel: z.string() }),
          activate: async () => () => undefined,
        }),
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        await registry.register(TEST_OWNER, [narrowed, ...source.types.filter((type) => type.kind !== TEST_KIND)]);

        await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(0));
        expect(source.lifecycle).toEqual(['activate:drop', 'cleanup:drop']);
        expect(source.live).toHaveLength(0);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no longer available'), expect.anything());
      } finally {
        warn.mockRestore();
      }
    });

    it.each([
      'filter',
      'filterExpression',
    ] as const)('rejects the removed `%s` key while parsing, before any event schema is consulted', async (key) => {
      await store('wf-legacy', [legacyBindings[key], { kind: TEST_KIND, params: { channel: 'valid' } }]);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const prepareBinding = vi.spyOn(runtime, 'prepareBinding');

      try {
        await reconciler.init();

        expect(reconciler.activeConsumerCount()).toBe(1);
        expect(source.live.map(({ channel }) => channel)).toEqual(['valid']);
        expect(error).toHaveBeenCalledWith(
          expect.stringContaining('leaving invalid trigger 0 of workflow "wf-legacy" inactive'),
          expect.anything(),
        );
        // The legacy binding never reached the binding runtime.
        expect(prepareBinding.mock.calls.map(([binding]) => binding.params)).toEqual([{ channel: 'valid' }]);
      } finally {
        prepareBinding.mockRestore();
        error.mockRestore();
      }
    });
  });

  it('drops handles when the contributing trigger type is deregistered and restores them on re-registration', async () => {
    await store('wf-lifecycle', [{ kind: TEST_KIND, params: { channel: 'cycle' } }]);
    await reconciler.init();
    expect(reconciler.activeConsumerCount()).toBe(1);

    // Extension disable, in the same order the contribution processor uses:
    // stop the owner's activations, then deregister the batch.
    await runtime.stopOwner(TEST_OWNER);
    await registry.deregister(TEST_OWNER);

    // The reconciler drops the now-unavailable consumer rather than retaining an
    // executable closure that could still start the workflow.
    await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(0));
    expect(source.live).toHaveLength(0);
    expect(starts).toHaveLength(0);

    // Extension re-enable. No workflow CRUD event is emitted here: the stored
    // definition alone must be enough to restore the binding.
    await registry.register(TEST_OWNER, source.types);

    await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(1));
    await vi.waitFor(() => expect(source.live).toHaveLength(1));

    await emitOn(source, 'cycle', { channel: 'cycle', value: 7 });
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toEqual({
      workflowId: 'wf-lifecycle',
      triggerPayload: { channel: 'cycle', value: 7 },
    });
  });

  it('drops schema-invalid old closures while continuing the owner reconciliation', async () => {
    await store('wf-schema-invalid', [{ kind: TEST_KIND, params: { channel: 'old' } }]);
    await store('wf-schema-valid', [{ kind: TEST_EAGER_KIND, params: { channel: 'survivor' } }]);
    await reconciler.init();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await registry.register(TEST_OWNER, [
        createSchemaChangedTestType(),
        ...source.types.filter((type) => type.kind !== TEST_KIND),
      ]);

      await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(1));
      await vi.waitFor(() => expect(source.live.map(({ channel }) => channel)).toEqual(['survivor']));
      expect(source.lifecycle).toContain('cleanup:old');
      expect(source.lifecycle.filter((event) => event === 'activate:survivor')).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('applies the stored definition rather than the payload a CRUD event carried', async () => {
    await store('wf-truth', [{ kind: TEST_KIND, params: { channel: 'stored' } }]);
    await reconciler.init();
    expect(source.lifecycle).toEqual(['activate:stored']);

    // A CRUD event is a refresh signal, not state. A payload that disagrees with
    // storage must not install a trigger storage does not describe.
    await MakaioBus.emit(
      WorkflowSubjects.definition.updated,
      createWorkflowDefinition({ id: 'wf-truth', triggers: [{ kind: TEST_KIND, params: { channel: 'spoofed' } }] }),
    );

    // A second signal is the barrier: reconciliation is a single FIFO lane, so
    // once this one has been applied the spoofed refresh has fully settled.
    await store('wf-barrier', [{ kind: TEST_KIND, params: { channel: 'barrier' } }]);
    await MakaioBus.emit(
      WorkflowSubjects.definition.created,
      createWorkflowDefinition({ id: 'wf-barrier', triggers: [{ kind: TEST_KIND, params: { channel: 'barrier' } }] }),
    );
    await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(2));

    expect(source.lifecycle).toEqual(['activate:stored', 'activate:barrier']);

    await emitOn(source, 'stored', { channel: 'stored', value: 1 });
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]?.workflowId).toBe('wf-truth');
  });

  it('forgets a workflow whose definition has been deleted', async () => {
    await store('wf-gone', [{ kind: TEST_KIND, params: { channel: 'gone' } }]);
    await reconciler.init();
    expect(source.live).toHaveLength(1);

    await MakaioBus.request(WorkflowStorageSubjects.delete, { id: 'wf-gone' });
    await MakaioBus.emit(
      WorkflowSubjects.definition.deleted,
      createWorkflowDefinition({ id: 'wf-gone', triggers: [{ kind: TEST_KIND, params: { channel: 'gone' } }] }),
    );

    await vi.waitFor(() => {
      expect(reconciler.activeConsumerCount()).toBe(0);
      expect(source.live).toHaveLength(0);
    });
    expect(source.lifecycle).toEqual(['activate:gone', 'cleanup:gone']);
    expect(starts).toHaveLength(0);
  });

  it('does not resurrect a workflow deleted while a registry-change reconciliation is in flight', async () => {
    const definition = createWorkflowDefinition({
      id: 'wf-race',
      triggers: [{ kind: TEST_KIND, params: { channel: 'race' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });
    await reconciler.init();
    expect(source.live).toHaveLength(1);

    // Holds one definition listing open *after* it has read storage, so the
    // reconciliation that consumes it is provably working from a snapshot taken
    // before the deletion below. Reads inside the lane make that harmless: the
    // deletion signal is ordered behind the reconciliation that outran it.
    const snapshotTaken = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let armed = true;
    const removeGate = MakaioBus.on(
      WorkflowStorageSubjects.list,
      async (ctx) => {
        if (!armed) return; // Pass the nested read through to real storage.
        armed = false;
        const snapshot = await MakaioBus.request(WorkflowStorageSubjects.list, ctx.payload);
        snapshotTaken.resolve();
        await release.promise;
        ctx.setResult(snapshot);
      },
      { priority: 10 },
    );

    try {
      void MakaioBus.emit(AutomationTriggerSubjects.changed, {
        owner: TEST_OWNER,
        revision: 1,
        kinds: [TEST_KIND],
        reason: 'registered',
      });
      await snapshotTaken.promise;

      await MakaioBus.request(WorkflowStorageSubjects.delete, { id: 'wf-race' });
      await MakaioBus.emit(WorkflowSubjects.definition.deleted, definition);

      release.resolve();

      await vi.waitFor(() => {
        expect(reconciler.activeConsumerCount()).toBe(0);
        expect(source.live).toHaveLength(0);
      });
      expect(starts).toHaveLength(0);
    } finally {
      release.resolve();
      removeGate();
    }
  });

  /**
   * Emits one automation trigger registry `changed` event.
   * @param owner - Owner whose trigger batch changed.
   * @param revision - Registry revision the event reports.
   * @param kinds - Exact trigger kinds whose registrations may have changed.
   * @returns Resolves once every handler has settled.
   */
  async function emitRegistryChange(owner: string, revision: number, kinds: string[]): Promise<void> {
    await MakaioBus.emit(AutomationTriggerSubjects.changed, { owner, revision, kinds, reason: 'registered' });
  }

  it('re-subscribes only bindings whose exact kinds a registry change names', async () => {
    await registry.register(OTHER_OWNER, [createOtherOwnerType()]);
    await store('wf-scoped', [{ kind: TEST_KIND, params: { channel: 'scoped' } }]);
    await store('wf-unrelated', [{ kind: OTHER_KIND, params: { channel: 'unrelated' } }]);
    await reconciler.init();
    expect(reconciler.activeConsumerCount()).toBe(2);

    // A registry change concerns exactly the kinds it names. Re-acquiring any
    // other binding would churn a subscription whose registration did not change.
    const prepareBinding = vi.spyOn(runtime, 'prepareBinding');

    try {
      await emitRegistryChange(TEST_OWNER, 2, [TEST_KIND]);
      await vi.waitFor(() => expect(prepareBinding).toHaveBeenCalledTimes(1));
      expect(prepareBinding.mock.calls.map(([binding]) => binding.kind)).toEqual([TEST_KIND]);

      // The other owner's own change reaches its own binding, which is also the
      // barrier proving the pass above had fully settled.
      await emitRegistryChange(OTHER_OWNER, 3, [OTHER_KIND]);
      await vi.waitFor(() => expect(prepareBinding).toHaveBeenCalledTimes(2));
      expect(prepareBinding.mock.calls.map(([binding]) => binding.kind)).toEqual([TEST_KIND, OTHER_KIND]);
    } finally {
      prepareBinding.mockRestore();
    }
  });

  it('does not refresh a nested owner whose name overlaps the changed owner', async () => {
    await registry.register(OVERLAPPING_PARENT_OWNER, [createScopedTriggerType(OVERLAPPING_PARENT_KIND)]);
    await registry.register(OVERLAPPING_NESTED_OWNER, [createScopedTriggerType(OVERLAPPING_NESTED_KIND)]);
    await store('wf-overlapping-parent', [{ kind: OVERLAPPING_PARENT_KIND, params: { channel: 'parent' } }]);
    await store('wf-overlapping-nested', [{ kind: OVERLAPPING_NESTED_KIND, params: { channel: 'nested' } }]);
    await reconciler.init();
    expect(reconciler.activeConsumerCount()).toBe(2);

    const prepareBinding = vi.spyOn(runtime, 'prepareBinding');
    try {
      await emitRegistryChange(OVERLAPPING_PARENT_OWNER, 3, [OVERLAPPING_PARENT_KIND]);

      await vi.waitFor(() => expect(prepareBinding).toHaveBeenCalledTimes(1));
      expect(prepareBinding.mock.calls[0]?.[0].kind).toBe(OVERLAPPING_PARENT_KIND);
    } finally {
      prepareBinding.mockRestore();
    }
  });

  it('replays one owner when an out-of-scope persisted sibling is invalid', async () => {
    await registry.register(OTHER_OWNER, [createOtherOwnerType()]);
    const definition = createWorkflowDefinition({
      id: 'wf-scoped-invalid-sibling',
      triggers: [
        { kind: TEST_KIND, params: { channel: 'recover' } },
        { kind: OTHER_KIND, params: { channel: 'untouched' } },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });
    await reconciler.init();
    expect(reconciler.activeConsumerCount()).toBe(2);
    expect(source.live.map(({ channel }) => channel)).toEqual(['recover']);

    // Storage can contain an invalid binding before a registry signal arrives.
    // Replaying TEST_OWNER must not compile OTHER_OWNER's binding: its existing
    // consumer remains last-good while the stopped TEST_OWNER source recovers.
    const invalidSibling = createWorkflowDefinition({
      id: definition.id,
      triggers: [
        { kind: TEST_KIND, params: { channel: 'recover' } },
        { ...legacyBindings.filterExpression, kind: OTHER_KIND, params: { channel: 'untouched' } },
      ],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: invalidSibling });
    await runtime.stopOwner(TEST_OWNER);
    expect(source.live).toHaveLength(0);

    const prepareBinding = vi.spyOn(runtime, 'prepareBinding');
    try {
      await registry.register(TEST_OWNER, source.types);

      await vi.waitFor(() => expect(source.live.map(({ channel }) => channel)).toEqual(['recover']));
      expect(prepareBinding.mock.calls.map(([binding]) => binding.kind)).toEqual([TEST_KIND]);
      expect(reconciler.activeConsumerCount()).toBe(2);

      await emitOn(source, 'recover', { channel: 'recover', value: 1 });
      await vi.waitFor(() => expect(starts).toHaveLength(1));
      expect(starts[0]?.workflowId).toBe(definition.id);
    } finally {
      prepareBinding.mockRestore();
    }
  });

  it('coalesces a burst of registry changes into one reconciliation pass', async () => {
    await registry.register(OTHER_OWNER, [createOtherOwnerType()]);
    await store('wf-burst', [{ kind: TEST_KIND, params: { channel: 'burst' } }]);
    await store('wf-burst-other', [{ kind: OTHER_KIND, params: { channel: 'burst' } }]);
    await reconciler.init();

    // One enable emits one `changed` per owner, and a contributor replay emits a
    // burst of them in a single turn. Each event carries a full definition listing
    // if it is reconciled on its own, so the burst must collapse into one pass over
    // the union of the owners it named.
    let listings = 0;
    const countListings = MakaioBus.on(
      WorkflowStorageSubjects.list,
      () => {
        listings += 1;
      },
      { priority: 10 },
    );
    const prepareBinding = vi.spyOn(runtime, 'prepareBinding');

    try {
      await Promise.all([
        emitRegistryChange(TEST_OWNER, 2, [TEST_KIND]),
        emitRegistryChange(TEST_OWNER, 3, [TEST_SCALAR_KIND]),
        emitRegistryChange(OTHER_OWNER, 4, [OTHER_KIND]),
      ]);

      // Bindings in the changed-kind union were re-acquired — not just the first
      // event's kind.
      await vi.waitFor(() => expect(prepareBinding).toHaveBeenCalledTimes(2));
      expect(prepareBinding.mock.calls.map(([binding]) => binding.kind).sort()).toEqual([OTHER_KIND, TEST_KIND]);
      expect(listings).toBe(1);
    } finally {
      prepareBinding.mockRestore();
      countListings();
    }
  });

  it('starts a workflow exactly once when an unchanged binding is refreshed', async () => {
    const definition = createWorkflowDefinition({
      id: 'wf-once',
      triggers: [{ kind: TEST_KIND, params: { channel: 'once' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });
    await reconciler.init();

    // Refreshing an unchanged binding replaces the consumer's listener through
    // the runtime's acquire-before-release overlap, during which two listeners of
    // the same consumer key are attached to one shared activation.
    await MakaioBus.emit(WorkflowSubjects.definition.updated, definition);
    await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(1));
    expect(source.live).toHaveLength(1);

    await emitOn(source, 'once', { channel: 'once', value: 1 });

    await vi.waitFor(() => expect(starts).toHaveLength(1));
    // A short settle window: a second start would arrive on a later microtask.
    await vi.waitFor(() => expect(reconciler.activeConsumerCount()).toBe(1));
    expect(starts).toEqual([{ workflowId: 'wf-once', triggerPayload: { channel: 'once', value: 1 } }]);
  });

  it('leaves declarative triggers inactive and warns when no binding runtime is available', async () => {
    await store('wf-no-runtime', [{ kind: TEST_KIND, params: { channel: 'orphan' } }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const detached = new WorkflowTriggerReconciler(MakaioBus, () => undefined);

    try {
      await detached.init();

      expect(detached.activeConsumerCount()).toBe(0);
      expect(source.live).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no automation trigger binding runtime is available'));
    } finally {
      await detached.destroy();
      warn.mockRestore();
    }
  });

  it('shares concurrent initialization and registers one refresh handler set', async () => {
    const definition = createWorkflowDefinition({
      id: 'wf-concurrent-init',
      triggers: [{ kind: TEST_KIND, params: { channel: 'concurrent' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });

    await Promise.all([reconciler.init(), reconciler.init()]);
    expect(source.lifecycle).toEqual(['activate:concurrent']);

    const prepareBinding = vi.spyOn(runtime, 'prepareBinding');
    try {
      await MakaioBus.emit(WorkflowSubjects.definition.updated, definition);
      await vi.waitFor(() => expect(prepareBinding).toHaveBeenCalledTimes(1));
    } finally {
      prepareBinding.mockRestore();
    }
  });

  it('rolls back failed initial signal handlers and retries initialization once', async () => {
    const definition = createWorkflowDefinition({
      id: 'wf-retry-init',
      triggers: [{ kind: TEST_KIND, params: { channel: 'retry' } }],
    });
    await MakaioBus.request(WorkflowStorageSubjects.set, { workflow: definition });

    let rejectListing = true;
    const rejectList = MakaioBus.on(
      WorkflowStorageSubjects.list,
      () => {
        if (rejectListing) throw new Error('initial list failed');
      },
      { priority: 10 },
    );

    try {
      await expect(reconciler.init()).rejects.toThrow('initial list failed');
      expect(reconciler.activeConsumerCount()).toBe(0);

      rejectListing = false;
      const prepareBinding = vi.spyOn(runtime, 'prepareBinding');
      try {
        await reconciler.init();
        expect(prepareBinding).toHaveBeenCalledTimes(1);

        await MakaioBus.emit(WorkflowSubjects.definition.updated, definition);
        await vi.waitFor(() => expect(prepareBinding).toHaveBeenCalledTimes(2));
      } finally {
        prepareBinding.mockRestore();
      }
    } finally {
      rejectList();
    }
  });

  it('detaches every subscription on destroy', async () => {
    await store('wf-teardown', [{ kind: TEST_KIND, params: { channel: 'teardown' } }]);
    await reconciler.init();
    expect(source.live).toHaveLength(1);

    await reconciler.destroy();

    expect(reconciler.activeConsumerCount()).toBe(0);
    expect(source.live).toHaveLength(0);
    expect(source.lifecycle).toEqual(['activate:teardown', 'cleanup:teardown']);
  });
});
