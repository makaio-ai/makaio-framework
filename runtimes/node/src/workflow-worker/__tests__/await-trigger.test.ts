import { describe, expect, it, vi } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import { createBusInstance } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import type { WorkflowDefinition, WorkflowWorkerConfig } from '@makaio/contracts';
import { BUS_EVENT_AUTOMATION_TRIGGER_KIND, CRON_AUTOMATION_TRIGGER_KIND } from '@makaio/contracts';
import { z } from 'zod';
import { resolveAwaitTriggerConfig } from '../await-trigger.js';

/** Namespace the await-mode tests emit their trigger events on. */
const DemoNamespace = createBusNamespace('demo', {
  started: z.object({ branch: z.string(), count: z.number() }),
  raw: z.any(),
});

/** Typed subject the tests emit on. */
const DemoStarted = DemoNamespace.subjects.started;

/** Untyped subject used to prove scalar bus events cannot resolve workflow await mode. */
const DemoRaw = DemoNamespace.subjects.raw;

/**
 * Build a minimal {@link WorkflowWorkerConfig} for await-trigger tests.
 * @param overrides - Optional config overrides.
 * @returns Valid worker config stub.
 */
function makeConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'wf-await-001' },
    executionId: 'exec-await-001',
    workflowId: 'wf-await-001',
    triggerPayload: {},
    triggerMode: 'await-trigger',
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    env: {},
    coordinatorSessionId: 'session-await-001',
    cancelSubject: 'workflow.cancel.wf-await-001',
    suspensionStrategy: 'wait-in-process',
    ...overrides,
  };
}

/**
 * Build a minimal workflow definition for await-trigger tests.
 * @param overrides - Optional definition overrides.
 * @returns Valid workflow definition.
 */
function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-await-001',
    name: 'Await Trigger Test',
    root: { id: 'wf-await-001__root', type: 'sequence', nodes: [] },
    scope: { type: 'global' },
    ...overrides,
  };
}

/**
 * Build a bus with the demo namespace registered.
 * @returns Bus instance ready for await-mode tests.
 */
function makeBus(): IMakaioBus {
  const bus = createBusInstance();
  bus.registerNamespace(DemoNamespace);
  return bus;
}

/**
 * Wrap a loaded-workflow stub around the declared trigger bindings.
 * @param triggers - Declarative trigger bindings.
 * @returns Loaded workflow stub accepted by `resolveAwaitTriggerConfig`.
 */
function makeLoaded(triggers: WorkflowDefinition['triggers']): Parameters<typeof resolveAwaitTriggerConfig>[1] {
  return { definition: makeDefinition({ triggers }), runtimeHandlers: new Map() };
}

describe('resolveAwaitTriggerConfig', () => {
  it('returns the config unchanged in immediate mode when a trigger payload is already present', async () => {
    const config = makeConfig({ triggerPayload: { branch: 'main', count: 1 }, triggerMode: 'immediate' });

    const resolved = await resolveAwaitTriggerConfig(
      config,
      makeLoaded([{ kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: 'demo.started' } }]),
      makeBus(),
      new AbortController().signal,
    );

    expect(resolved).toBe(config);
  });

  it('preserves an empty payload as data in immediate mode', async () => {
    const config = makeConfig({ triggerPayload: {}, triggerMode: 'immediate' });

    const resolved = await resolveAwaitTriggerConfig(
      config,
      makeLoaded([{ kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: 'demo.started' } }]),
      makeBus(),
      new AbortController().signal,
    );

    expect(resolved).toBe(config);
    expect(resolved.triggerPayload).toEqual({});
  });

  it('executes an empty event payload immediately when no await mode was requested', async () => {
    const config = makeConfig({ triggerPayload: {}, triggerMode: undefined });

    const resolved = await resolveAwaitTriggerConfig(
      config,
      makeLoaded([{ kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: 'demo.started' } }]),
      makeBus(),
      new AbortController().signal,
    );

    expect(resolved).toBe(config);
  });

  it('resolves with the first payload passing both filter and filterExpression', async () => {
    const bus = makeBus();
    let resolved: WorkflowWorkerConfig | undefined;

    const pending = resolveAwaitTriggerConfig(
      makeConfig(),
      makeLoaded([
        {
          kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND,
          params: { subject: 'demo.started' },
          filter: { branch: 'main' },
          filterExpression: 'payload.count > 5',
        },
      ]),
      bus,
      new AbortController().signal,
    ).then((value) => {
      resolved = value;
      return value;
    });

    // Retried so the await is subscribed before the decisive emit. The first two
    // payloads must be rejected — by the structural filter and by the jexl
    // expression respectively — so a leaking filter surfaces as the wrong payload.
    await vi.waitFor(async () => {
      await bus.emit(DemoStarted, { branch: 'feature', count: 9 });
      await bus.emit(DemoStarted, { branch: 'main', count: 1 });
      await bus.emit(DemoStarted, { branch: 'main', count: 9 });
      expect(resolved).toBeDefined();
    });

    expect((await pending).triggerPayload).toEqual({ branch: 'main', count: 9 });
  });

  it('ignores scalar bus events and resolves only with an object-root payload', async () => {
    const bus = makeBus();
    let resolved: WorkflowWorkerConfig | undefined;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const pending = resolveAwaitTriggerConfig(
        makeConfig(),
        makeLoaded([{ kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: 'demo.raw' } }]),
        bus,
        new AbortController().signal,
      ).then((value) => {
        resolved = value;
        return value;
      });

      await vi.waitFor(async () => {
        await bus.emit(DemoRaw, 'scalar' as never);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('skipped non-object JSON payload'),
          expect.anything(),
        );
      });
      expect(resolved).toBeUndefined();

      await bus.emit(DemoRaw, { branch: 'main', count: 2 });
      expect((await pending).triggerPayload).toEqual({ branch: 'main', count: 2 });
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects when a declared binding cannot be activated', async () => {
    // The first binding activates, while the second names a subject that carries
    // no namespace and therefore cannot be observed at all. The await fails
    // instead of silently narrowing to the bindings that happened to work, and
    // disposes its whole trigger surface either way.
    await expect(
      resolveAwaitTriggerConfig(
        makeConfig(),
        makeLoaded([
          { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: 'demo.started' } },
          { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: 'started' } },
        ]),
        makeBus(),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it('skips a cron binding, because a worker never owns where a schedule runs', async () => {
    const config = makeConfig();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // A worker that scheduled cron locally would fire a schedule the host has
      // already placed — possibly on a different machine — a second time.
      const resolved = await resolveAwaitTriggerConfig(
        config,
        makeLoaded([{ kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '*/5 * * * *' } }]),
        makeBus(),
        new AbortController().signal,
      );

      expect(resolved).toBe(config);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('awaiting it inside a worker is unsupported'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not leave the match promise unhandled when an abort races subscription', async () => {
    const controller = new AbortController();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const pending = resolveAwaitTriggerConfig(
        makeConfig(),
        makeLoaded([
          { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: 'demo.started' } },
          { kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: 'started' } },
        ]),
        makeBus(),
        controller.signal,
      );

      // Aborts while the subscriptions are still being acquired, and one of them
      // then fails: the await rejects with the activation failure, so nothing ever
      // awaits the abort-rejected match promise.
      controller.abort(new Error('worker cancelled'));

      await expect(pending).rejects.toThrow();
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rejects when the abort signal fires before any trigger matches', async () => {
    const controller = new AbortController();

    const pending = resolveAwaitTriggerConfig(
      makeConfig(),
      makeLoaded([{ kind: BUS_EVENT_AUTOMATION_TRIGGER_KIND, params: { subject: 'demo.started' } }]),
      makeBus(),
      controller.signal,
    );

    controller.abort(new Error('worker cancelled'));

    await expect(pending).rejects.toThrow('worker cancelled');
  });

  it('returns the config unchanged when no declared binding exists in this worker', async () => {
    const config = makeConfig();

    const resolved = await resolveAwaitTriggerConfig(
      config,
      makeLoaded([{ kind: 'some-extension.webhook', params: { path: '/hook' } }]),
      makeBus(),
      new AbortController().signal,
    );

    expect(resolved).toBe(config);
  });
});
