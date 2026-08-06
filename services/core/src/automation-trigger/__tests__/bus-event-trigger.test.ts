import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import { NoHandlerError, createBusInstance } from '@makaio/bus-core';
import { createBusNamespace, getFullSubjectForSubjectDefinition } from '@makaio/core';
import { BUS_EVENT_AUTOMATION_TRIGGER_KIND, createAutomationTriggerDescriptor } from '@makaio/contracts';
import type { AutomationTriggerEvent } from '@makaio/contracts';
import { ExtensionCoordinator } from '@makaio/kernel';
import type { KernelExtensionContext } from '@makaio/kernel';
import type { AutomationTriggerBindingRuntime } from '../automation-trigger-binding-runtime.js';
import { createBusEventAutomationTrigger } from '../builtins/bus-event-trigger.js';
import { createAutomationTriggerContributionProcessor } from '../automation-trigger-contribution-processor.js';
import {
  AutomationTriggerBindingRuntimeToken,
  automationTriggerBindingRuntimePackage,
  automationTriggerRegistryPackage,
} from '../packages.js';
import { automationTriggerBuiltinsPackage } from '../builtins/package.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

/**
 * Minimal {@link KernelExtensionContext} fields (excluding coordinator-owned
 * and bus-owned fields) for test coordinators.
 */
const TEST_PKG_CTX_BASE: Omit<
  KernelExtensionContext,
  'bus' | 'identity' | 'getService' | 'dataDir' | 'config' | 'signal' | 'hasExtension'
> = {
  platform: 'linux',
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async (_specifier) => null,
};

/**
 * Test-only namespace standing in for a product namespace.
 *
 * `raw` accepts any value so the suite can emit a payload that the bus admits
 * but JSON cannot represent.
 */
const testAutoNamespace = createBusNamespace('testAuto', {
  ticked: z.object({ index: z.number() }),
  raw: z.any(),
  ask: { request: z.object({}), response: z.object({ ok: z.boolean() }) },
});

/**
 * Test-only namespace whose name carries a `:` hierarchy segment.
 *
 * Its subject keys look like `testAuto:child.ticked`, which is the shape a
 * namespace-derivation bug would mis-parse into the parent namespace.
 */
const testAutoChildNamespace = createBusNamespace('testAuto:child', {
  ticked: z.object({ index: z.number() }),
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Booted harness: real coordinator, real binding runtime, real bus. */
interface Harness {
  readonly bus: IMakaioBus;
  readonly coordinator: ExtensionCoordinator;
  readonly runtime: AutomationTriggerBindingRuntime;
  /** Full subject keys of the test namespace, resolved from its definitions. */
  readonly subjects: {
    readonly ticked: string;
    readonly raw: string;
    readonly ask: string;
  };
  /** Full subject keys of the hierarchical child namespace. */
  readonly childSubjects: {
    readonly ticked: string;
  };
}

/** Harnesses booted by the current test, shut down in `afterEach`. */
const harnesses: Harness[] = [];

/**
 * Boots the registry, the binding runtime, and the built-ins package on a fresh
 * bus instance.
 * @returns The booted harness.
 */
async function bootHarness(): Promise<Harness> {
  const bus = createBusInstance();
  const { subjects } = bus.registerNamespace(testAutoNamespace);
  const { subjects: childSubjects } = bus.registerNamespace(testAutoChildNamespace);

  const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });
  coordinator.registerContributionProcessor(
    createAutomationTriggerContributionProcessor({
      forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
    }),
  );
  coordinator.load([
    automationTriggerRegistryPackage,
    automationTriggerBindingRuntimePackage,
    automationTriggerBuiltinsPackage,
  ]);
  await coordinator.startAll();

  const runtime = coordinator.getExtensionService(AutomationTriggerBindingRuntimeToken);
  if (!runtime) throw new Error('AutomationTriggerBindingRuntime service did not start');

  const harness: Harness = {
    bus,
    coordinator,
    runtime,
    subjects: {
      ticked: getFullSubjectForSubjectDefinition(subjects.ticked),
      raw: getFullSubjectForSubjectDefinition(subjects.raw),
      ask: getFullSubjectForSubjectDefinition(subjects.ask),
    },
    childSubjects: { ticked: getFullSubjectForSubjectDefinition(childSubjects.ticked) },
  };
  harnesses.push(harness);
  return harness;
}

/**
 * Collects every event delivered to a listener.
 * @returns The recorded events and the listener to subscribe with.
 */
function createRecorder(): {
  readonly events: AutomationTriggerEvent[];
  readonly listener: (event: AutomationTriggerEvent) => void;
} {
  const events: AutomationTriggerEvent[] = [];
  return { events, listener: (event) => void events.push(event) };
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.coordinator.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makaio.bus-event built-in automation trigger', () => {
  it('advertises the observable-subject invariant in its detached descriptor', () => {
    const descriptor = createAutomationTriggerDescriptor(createBusEventAutomationTrigger(createBusInstance()));

    expect(descriptor.parameterSchema).toMatchObject({
      properties: {
        subject: {
          type: 'string',
          pattern: '^[^.]+\\.[\\s\\S]+$',
        },
      },
      required: ['subject'],
    });
    expect(descriptor.workflowCompatible).toBe(true);
  });

  it('forwards matching events to the subscriber exactly once', async () => {
    const harness = await bootHarness();
    const { events, listener } = createRecorder();

    await harness.runtime.subscribe(
      { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.ticked } },
      listener,
    );

    await harness.bus.emit(testAutoNamespace.subjects.ticked, { index: 1 });

    // Exactly one delivery is the observable proof that the activation installed
    // exactly one bus subscription: a second subscription would fan the same
    // event into the same activation twice.
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.kind).toBe(BUS_EVENT_AUTOMATION_TRIGGER_KIND);
    expect(events[0]?.payload).toEqual({ index: 1 });
  });

  it('does not filter events for the subscriber beyond the bound subject', async () => {
    const harness = await bootHarness();
    const { events, listener } = createRecorder();

    await harness.runtime.subscribe(
      { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.ticked } },
      listener,
    );

    // Every payload shape on the bound subject reaches the subscriber: consumer
    // filtering is not a trigger-source concern.
    await harness.bus.emit(testAutoNamespace.subjects.ticked, { index: 1 });
    await harness.bus.emit(testAutoNamespace.subjects.ticked, { index: 2 });
    // A different subject in the same namespace must not reach the subscriber.
    await harness.bus.emit(testAutoNamespace.subjects.raw, { value: 'ignored' });

    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events.map((event) => event.payload)).toEqual([{ index: 1 }, { index: 2 }]);
  });

  it('shares one activation, and one bus subscription, across equivalent bindings', async () => {
    const harness = await bootHarness();
    const first = createRecorder();
    const second = createRecorder();

    await harness.runtime.subscribe(
      { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.ticked } },
      first.listener,
    );
    await harness.runtime.subscribe(
      { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.ticked } },
      second.listener,
    );

    await harness.bus.emit(testAutoNamespace.subjects.ticked, { index: 7 });

    await vi.waitFor(() => {
      expect(first.events).toHaveLength(1);
      expect(second.events).toHaveLength(1);
    });
  });

  it('forwards the emitting event context correlation id', async () => {
    const harness = await bootHarness();
    const { events, listener } = createRecorder();

    await harness.runtime.subscribe(
      { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.ticked } },
      listener,
    );

    await harness.bus.emit(testAutoNamespace.subjects.ticked, { index: 3 }, { correlationId: 'corr-42' });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.correlationId).toBe('corr-42');
  });

  it('skips and logs a payload that JSON cannot represent instead of throwing', async () => {
    const harness = await bootHarness();
    const { events, listener } = createRecorder();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await harness.runtime.subscribe(
        { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.raw } },
        listener,
      );

      // The emitter must not observe a trigger-side validation failure.
      await expect(harness.bus.emit(testAutoNamespace.subjects.raw, { value: () => 1 })).resolves.toBeUndefined();
      await harness.bus.emit(testAutoNamespace.subjects.raw, { value: 'json' });

      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]?.payload).toEqual({ value: 'json' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped non-object JSON payload'), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('skips and logs scalar JSON payloads instead of projecting them', async () => {
    const harness = await bootHarness();
    const { events, listener } = createRecorder();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await harness.runtime.subscribe(
        { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.raw } },
        listener,
      );

      await expect(harness.bus.emit(testAutoNamespace.subjects.raw, 'scalar' as never)).resolves.toBeUndefined();

      expect(events).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped non-object JSON payload'), expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores requests that match the bound subject', async () => {
    const harness = await bootHarness();
    const { events, listener } = createRecorder();

    const barrier = createRecorder();
    const unsubscribe = harness.bus.on(testAutoNamespace.subjects.ask, (ctx) => {
      ctx.setResult({ ok: true });
    });

    try {
      await harness.runtime.subscribe(
        { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.ask } },
        listener,
      );
      await harness.runtime.subscribe(
        { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.ticked } },
        barrier.listener,
      );

      await expect(harness.bus.request(testAutoNamespace.subjects.ask, {})).resolves.toEqual({ ok: true });
      // The event emitted afterwards is the barrier: once it has been delivered,
      // any delivery the request could have caused would already have happened.
      await harness.bus.emit(testAutoNamespace.subjects.ticked, { index: 9 });

      await vi.waitFor(() => expect(barrier.events).toHaveLength(1));
      expect(events).toHaveLength(0);
    } finally {
      unsubscribe();
    }

    // With the only real handler gone, the activation's namespace wildcard must
    // not stand in as a request route: an activation registered in the request
    // map would answer here — and would be advertised to remote transports as an
    // RPC handler for the whole namespace.
    await expect(harness.bus.request(testAutoNamespace.subjects.ask, {})).rejects.toBeInstanceOf(NoHandlerError);
  });

  it('observes a subject whose namespace is itself hierarchical', async () => {
    const harness = await bootHarness();
    const { events, listener } = createRecorder();

    // `:` is a namespace-hierarchy boundary, not a namespace/subject separator:
    // the namespace of `testAuto:child.ticked` is `testAuto:child`, so the
    // activation must subscribe `testAuto:child.*` rather than `testAuto.*`.
    expect(harness.childSubjects.ticked).toBe('testAuto:child.ticked');

    await harness.runtime.subscribe(
      { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.childSubjects.ticked } },
      listener,
    );

    await harness.bus.emit(testAutoChildNamespace.subjects.ticked, { index: 5 });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]?.payload).toEqual({ index: 5 });
  });

  it('rejects a subject that carries no namespace before activation', async () => {
    const harness = await bootHarness();
    const { listener } = createRecorder();

    // A dot-less pattern is not a subject key, so no namespace wildcard can
    // express it. Failing loudly beats installing a subscription that would
    // report a healthy binding and never fire.
    await expect(
      harness.runtime.subscribe({ kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: 'github' } }, listener),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('rejects a subject with an empty namespace or subject segment before activation', async () => {
    const harness = await bootHarness();
    const { listener } = createRecorder();

    // `.ticked` and `testAuto.` carry a dot but name only one segment, so no
    // emitter can ever produce them either — they are rejected for the same
    // reason a dot-less pattern is, instead of installing a dead subscription
    // (a `.`-leading pattern would derive the empty namespace).
    for (const subject of ['.ticked', 'testAuto.']) {
      await expect(
        harness.runtime.subscribe({ kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject } }, listener),
      ).rejects.toBeInstanceOf(z.ZodError);
    }
  });

  it('unsubscribes from the bus when the last subscriber detaches', async () => {
    const harness = await bootHarness();
    const { events, listener } = createRecorder();

    const subscription = await harness.runtime.subscribe(
      { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.ticked } },
      listener,
    );

    await harness.bus.emit(testAutoNamespace.subjects.ticked, { index: 1 });
    await vi.waitFor(() => expect(events).toHaveLength(1));

    await subscription.detach();
    await harness.bus.emit(testAutoNamespace.subjects.ticked, { index: 2 });

    // Re-subscribing proves the bus is live again while the detached listener
    // stays silent, so the first activation's bus handler is gone.
    const probe = createRecorder();
    await harness.runtime.subscribe(
      { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: harness.subjects.ticked } },
      probe.listener,
    );
    await harness.bus.emit(testAutoNamespace.subjects.ticked, { index: 3 });

    await vi.waitFor(() => expect(probe.events).toHaveLength(1));
    expect(probe.events[0]?.payload).toEqual({ index: 3 });
    expect(events).toHaveLength(1);
  });
});
