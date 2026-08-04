import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import {
  createReactionRuleRef,
  defineReaction,
  type ReactionDefinition,
  type ReactionExecutionContext,
} from '@makaio/contracts';
import { ReactionRegistry, type ReactionInvocationInput } from '../reaction-registry.js';

/**
 * Builds a minimal invocation input for tests.
 * @param overrides - Fields to override on the default input.
 * @returns Host-supplied invocation input.
 */
function makeInput(overrides: Partial<ReactionInvocationInput> = {}): ReactionInvocationInput {
  return {
    eventKind: 'test.event',
    eventPayload: { value: 1 },
    hostContext: { host: 'test' },
    ...overrides,
  };
}

/**
 * Defines a simple notify Reaction for the given extension.
 * @param extensionName - Owning extension name used as the kind prefix.
 * @param onInvoke - Optional callback observing validated parameters and context.
 * @returns A Reaction definition with a `{ message: string }` parameter schema.
 */
function makeNotifyReaction(
  extensionName: string,
  onInvoke?: (parameters: Readonly<{ message: string }>, context: ReactionExecutionContext) => Promise<void> | void,
): ReactionDefinition {
  return defineReaction({
    kind: `${extensionName}.notify`,
    description: 'Notifies someone.',
    parameterSchema: z.object({ message: z.string() }),
    handler: async (parameters, context) => {
      await onInvoke?.(parameters, context);
    },
  });
}

describe('ReactionRegistry', () => {
  let registry: ReactionRegistry;

  beforeEach(async () => {
    registry = new ReactionRegistry(createBusInstance());
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await registry.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await registry.destroy();
  });

  describe('register', () => {
    it('hard-fails on a kind outside the extension namespace', () => {
      const foreign = defineReaction({
        kind: 'other.notify',
        description: 'Wrong namespace.',
        parameterSchema: z.object({}),
        handler: async () => {},
      });
      expect(() => registry.register('alpha', [foreign])).toThrow(
        "Reaction 'other.notify' must be namespaced by extension 'alpha.'",
      );
      expect(registry.listDescriptors()).toEqual([]);
    });

    it('rejects the bare extension prefix while allowing extension names with dots', () => {
      const barePrefix = defineReaction({
        kind: 'alpha.',
        description: 'Has no local Reaction name.',
        parameterSchema: z.object({}),
        handler: async () => {},
      });

      expect(() => registry.register('alpha', [barePrefix])).toThrow(
        "Reaction 'alpha.' must be namespaced by extension 'alpha.'",
      );
      expect(() => registry.register('alpha.team', [makeNotifyReaction('alpha.team')])).not.toThrow();
    });

    it('hard-fails on an in-batch collision without partial registration', () => {
      const first = makeNotifyReaction('alpha');
      const duplicate = makeNotifyReaction('alpha');
      expect(() => registry.register('alpha', [first, duplicate])).toThrow(
        "Reaction kind collision: 'alpha.notify' appears twice in batch from 'alpha'",
      );
      expect(registry.listDescriptors()).toEqual([]);
    });

    it('atomically replaces an owner batch and removes it for an empty batch', async () => {
      const originalHandler = vi.fn(async () => {});
      const replacementHandler = vi.fn(async () => {});
      registry.register('alpha', [makeNotifyReaction('alpha', originalHandler)]);

      registry.register('alpha', [
        defineReaction({
          kind: 'alpha.log',
          description: 'Replacement Reaction.',
          parameterSchema: z.object({}),
          handler: replacementHandler,
        }),
      ]);

      await expect(registry.invoke('alpha.notify', { message: 'hi' }, makeInput())).resolves.toMatchObject({
        success: false,
      });
      await expect(registry.invoke('alpha.log', {}, makeInput())).resolves.toEqual({ success: true });
      expect(originalHandler).not.toHaveBeenCalled();
      expect(replacementHandler).toHaveBeenCalledTimes(1);

      registry.register('alpha', []);
      expect(registry.listDescriptors()).toEqual([]);
    });

    it('keeps the registered executable snapshot stable when a contributed definition is mutated later', async () => {
      const originalHandler = vi.fn(async () => {});
      const original = makeNotifyReaction('alpha', originalHandler);
      registry.register('alpha', [original]);

      // Runtime definitions are extension-owned executable values. Registry
      // entries must retain every value captured at registration, even if a
      // misbehaving contributor later mutates its original object.
      const mutatedHandler = vi.fn(async () => {});
      const mutated = original as {
        kind: string;
        parameterSchema: ReactionDefinition['parameterSchema'];
        handler: ReactionDefinition['handler'];
      };
      mutated.kind = 'beta.mutated';
      mutated.parameterSchema = z.object({ replacement: z.number() });
      mutated.handler = mutatedHandler;

      registry.register('gamma', [makeNotifyReaction('gamma')]);

      expect(
        registry
          .listDescriptors()
          .map((descriptor) => descriptor.kind)
          .sort(),
      ).toEqual(['alpha.notify', 'gamma.notify']);
      await expect(registry.invoke('alpha.notify', { message: 'hi' }, makeInput())).resolves.toEqual({ success: true });
      await expect(registry.invoke('alpha.notify', { replacement: 1 }, makeInput())).resolves.toMatchObject({
        success: false,
      });
      expect(originalHandler).toHaveBeenCalledTimes(1);
      expect(mutatedHandler).not.toHaveBeenCalled();
      await expect(registry.invoke('beta.mutated', { message: 'hi' }, makeInput())).resolves.toMatchObject({
        success: false,
      });
      expect(() =>
        registry.register('beta', [
          defineReaction({
            kind: 'beta.mutated',
            description: 'Confirms the mutated live kind is not indexed.',
            parameterSchema: z.object({}),
            handler: async () => {},
          }),
        ]),
      ).not.toThrow();
    });

    it('rejects another owner collision without disturbing the prior owner batch', async () => {
      registry.register('alpha', [makeNotifyReaction('alpha')]);
      registry.register('alpha.team', [makeNotifyReaction('alpha.team')]);

      const collidingReaction = defineReaction({
        kind: 'alpha.team.notify',
        description: 'Collides with alpha.team.',
        parameterSchema: z.object({}),
        handler: async () => {},
      });
      expect(() => registry.register('alpha', [collidingReaction])).toThrow(
        "Reaction kind collision: 'alpha.team.notify' is already registered",
      );

      await expect(registry.invoke('alpha.notify', { message: 'hi' }, makeInput())).resolves.toEqual({ success: true });
      expect(
        registry
          .listDescriptors()
          .map((descriptor) => descriptor.kind)
          .sort(),
      ).toEqual(['alpha.notify', 'alpha.team.notify']);
    });

    it('preserves prior descriptors and handlers when replacement descriptors throw or are invalid', async () => {
      const originalHandler = vi.fn(async () => {});
      registry.register('alpha', [makeNotifyReaction('alpha', originalHandler)]);
      const throwingDescriptor = {
        kind: 'alpha.throwing-descriptor',
        description: 'Throws while producing discovery metadata.',
        parameterSchema: z.object({}),
        handler: async () => {},
        toDescriptor: (): never => {
          throw new Error('descriptor exploded');
        },
      } satisfies ReactionDefinition;
      const invalidDescriptor = {
        kind: 'alpha.invalid-descriptor',
        description: 'Returns invalid discovery metadata.',
        parameterSchema: z.object({}),
        handler: async () => {},
        toDescriptor: () => ({
          kind: 'alpha.invalid-descriptor',
          description: '',
          parameterSchema: {},
        }),
      } satisfies ReactionDefinition;

      expect(() => registry.register('alpha', [throwingDescriptor])).toThrow('descriptor exploded');
      expect(() => registry.register('alpha', [invalidDescriptor])).toThrow();

      expect(registry.listDescriptors().map((descriptor) => descriptor.kind)).toEqual(['alpha.notify']);
      await expect(registry.invoke('alpha.notify', { message: 'hi' }, makeInput())).resolves.toEqual({ success: true });
      expect(originalHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('deregister', () => {
    it('removes all Reactions of an extension and is idempotent', async () => {
      registry.register('alpha', [makeNotifyReaction('alpha')]);
      registry.register('beta', [makeNotifyReaction('beta')]);

      registry.deregister('alpha');
      registry.deregister('alpha');

      expect(registry.listDescriptors().map((descriptor) => descriptor.kind)).toEqual(['beta.notify']);
      const outcome = await registry.invoke('alpha.notify', { message: 'x' }, makeInput());
      expect(outcome.success).toBe(false);
    });

    it('lets an in-flight invocation complete after its extension deregisters mid-flight', async () => {
      let releaseHandler: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      let entered: (() => void) | undefined;
      const handlerEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      registry.register('alpha', [
        makeNotifyReaction('alpha', async () => {
          entered?.();
          await gate;
        }),
      ]);

      const inFlight = registry.invoke('alpha.notify', { message: 'hi' }, makeInput());
      await handlerEntered;
      registry.deregister('alpha');
      releaseHandler?.();

      await expect(inFlight).resolves.toEqual({ success: true });
      await expect(registry.invoke('alpha.notify', { message: 'hi' }, makeInput())).resolves.toEqual({
        success: false,
        error: { message: "Reaction kind 'alpha.notify' is not registered" },
      });
    });
  });

  describe('invoke', () => {
    it('runs equivalent dispatches independently without deduplication', async () => {
      const handler = vi.fn(async () => {});
      registry.register('alpha', [makeNotifyReaction('alpha', handler)]);

      const [first, second] = await Promise.all([
        registry.invoke('alpha.notify', { message: 'hi' }, makeInput()),
        registry.invoke('alpha.notify', { message: 'hi' }, makeInput()),
      ]);

      expect(first).toEqual({ success: true });
      expect(second).toEqual({ success: true });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('returns a failure outcome for an unknown kind without throwing', async () => {
      const outcome = await registry.invoke('ghost.notify', {}, makeInput({ correlationId: 'corr-1' }));

      expect(outcome).toEqual({
        success: false,
        error: { message: "Reaction kind 'ghost.notify' is not registered" },
      });
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Reaction 'ghost.notify' invocation '"));
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('(correlationId: corr-1)'));
    });

    it('validates parameters before handler entry and fails without invoking it', async () => {
      const handler = vi.fn(async () => {});
      registry.register('alpha', [makeNotifyReaction('alpha', handler)]);

      const outcome = await registry.invoke('alpha.notify', { message: 42 }, makeInput());

      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.message).toContain("Invalid parameters for Reaction 'alpha.notify'");
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it('normalizes a throwing Zod transform to a failure outcome without entering the handler', async () => {
      const handler = vi.fn(async () => {});
      registry.register('alpha', [
        defineReaction({
          kind: 'alpha.explosive',
          description: 'Has a throwing transform.',
          parameterSchema: z.object({ message: z.string() }).transform((): { message: string } => {
            throw new Error('transform exploded');
          }),
          handler,
        }),
      ]);

      const outcome = await registry.invoke('alpha.explosive', { message: 'hi' }, makeInput());

      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.message).toContain("Parameter validation for Reaction 'alpha.explosive' threw");
        expect(outcome.error.message).toContain('transform exploded');
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it('normalizes an async refinement rejection to a validation failure without rejecting', async () => {
      const handler = vi.fn(async () => {});
      registry.register('alpha', [
        defineReaction({
          kind: 'alpha.async-refined',
          description: 'Has an async refinement.',
          parameterSchema: z
            .object({ message: z.string() })
            .refine(async () => false, { message: 'refinement said no' }),
          handler,
        }),
      ]);

      const outcome = await registry.invoke('alpha.async-refined', { message: 'hi' }, makeInput());

      expect(outcome.success).toBe(false);
      if (!outcome.success) {
        expect(outcome.error.message).toContain("Invalid parameters for Reaction 'alpha.async-refined'");
        expect(outcome.error.message).toContain('refinement said no');
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it('normalizes a thrown Error once without retrying the handler', async () => {
      const handler = vi.fn(() => {
        throw new Error('boom');
      });
      registry.register('alpha', [makeNotifyReaction('alpha', handler)]);

      const outcome = await registry.invoke('alpha.notify', { message: 'hi' }, makeInput());

      expect(outcome).toEqual({ success: false, error: { message: 'boom' } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('normalizes a thrown non-Error string to a failure outcome', async () => {
      registry.register('alpha', [
        makeNotifyReaction('alpha', () => {
          throw 'string failure';
        }),
      ]);

      const outcome = await registry.invoke('alpha.notify', { message: 'hi' }, makeInput());

      expect(outcome).toEqual({ success: false, error: { message: 'string failure' } });
    });

    it('never enters the handler when the host signal is already aborted', async () => {
      const handler = vi.fn(async () => {});
      registry.register('alpha', [makeNotifyReaction('alpha', handler)]);

      const outcome = await registry.invoke(
        'alpha.notify',
        { message: 'hi' },
        makeInput({ hostSignal: AbortSignal.abort() }),
      );

      expect(outcome).toEqual({
        success: false,
        error: { message: "Reaction 'alpha.notify' host signal already aborted" },
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it('never enters the handler when the deadline already passed', async () => {
      const handler = vi.fn(async () => {});
      registry.register('alpha', [makeNotifyReaction('alpha', handler)]);

      const outcome = await registry.invoke(
        'alpha.notify',
        { message: 'hi' },
        makeInput({ deadlineEpochMs: Date.now() - 1 }),
      );

      expect(outcome).toEqual({
        success: false,
        error: { message: "Reaction 'alpha.notify' deadline already passed" },
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not enter the handler when the host aborts during async parameter validation', async () => {
      const hostController = new AbortController();
      let releaseValidation: (() => void) | undefined;
      const validationGate = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      let markValidationStarted: (() => void) | undefined;
      const validationStarted = new Promise<void>((resolve) => {
        markValidationStarted = resolve;
      });
      const handler = vi.fn(async () => {});
      registry.register('alpha', [
        defineReaction({
          kind: 'alpha.async-host-abort',
          description: 'Waits for async validation.',
          parameterSchema: z.object({ message: z.string() }).refine(async () => {
            markValidationStarted?.();
            await validationGate;
            return true;
          }),
          handler,
        }),
      ]);

      const invocation = registry.invoke(
        'alpha.async-host-abort',
        { message: 'hi' },
        makeInput({ hostSignal: hostController.signal }),
      );
      await validationStarted;
      hostController.abort(new Error('host shutdown'));
      releaseValidation?.();

      await expect(invocation).resolves.toEqual({
        success: false,
        error: { message: "Reaction 'alpha.async-host-abort' cancelled before handler entry: host shutdown" },
      });
      expect(handler).not.toHaveBeenCalled();
    });

    it('does not enter the handler when the deadline expires during async parameter validation', async () => {
      vi.useFakeTimers();
      try {
        let releaseValidation: (() => void) | undefined;
        const validationGate = new Promise<void>((resolve) => {
          releaseValidation = resolve;
        });
        let markValidationStarted: (() => void) | undefined;
        const validationStarted = new Promise<void>((resolve) => {
          markValidationStarted = resolve;
        });
        const handler = vi.fn(async () => {});
        registry.register('alpha', [
          defineReaction({
            kind: 'alpha.async-deadline',
            description: 'Waits for async validation.',
            parameterSchema: z.object({ message: z.string() }).refine(async () => {
              markValidationStarted?.();
              await validationGate;
              return true;
            }),
            handler,
          }),
        ]);

        const deadlineEpochMs = Date.now() + 1_000;
        const invocation = registry.invoke('alpha.async-deadline', { message: 'hi' }, makeInput({ deadlineEpochMs }));
        await validationStarted;
        await vi.advanceTimersByTimeAsync(1_000);
        releaseValidation?.();

        await expect(invocation).resolves.toEqual({
          success: false,
          error: {
            message: `Reaction 'alpha.async-deadline' cancelled before handler entry: Reaction invocation deadline reached (deadlineEpochMs: ${deadlineEpochMs})`,
          },
        });
        expect(handler).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not enter the handler when synchronous validation crosses a deadline before its timer runs', async () => {
      vi.useFakeTimers({ now: 0 });
      try {
        const deadlineEpochMs = 1_000;
        const handler = vi.fn(async () => {});
        registry.register('alpha', [
          defineReaction({
            kind: 'alpha.sync-deadline',
            description: 'Advances the clock while validating.',
            parameterSchema: z.object({ message: z.string() }).superRefine(() => {
              // Changing fake system time does not execute the scheduled
              // deadline callback, which reproduces event-loop starvation.
              vi.setSystemTime(deadlineEpochMs);
            }),
            handler,
          }),
        ]);

        await expect(
          registry.invoke('alpha.sync-deadline', { message: 'hi' }, makeInput({ deadlineEpochMs })),
        ).resolves.toEqual({
          success: false,
          error: {
            message: `Reaction 'alpha.sync-deadline' cancelled before handler entry: Reaction invocation deadline reached (deadlineEpochMs: ${deadlineEpochMs})`,
          },
        });
        expect(handler).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts the per-invocation signal when the deadline is reached mid-flight', async () => {
      vi.useFakeTimers();
      try {
        let observedAbort = false;
        registry.register('alpha', [
          makeNotifyReaction('alpha', async (_parameters, context) => {
            await new Promise<void>((resolve) => {
              context.signal.addEventListener(
                'abort',
                () => {
                  observedAbort = true;
                  resolve();
                },
                { once: true },
              );
            });
            throw context.signal.reason;
          }),
        ]);

        const inFlight = registry.invoke(
          'alpha.notify',
          { message: 'hi' },
          makeInput({ deadlineEpochMs: Date.now() + 1_000 }),
        );
        await vi.advanceTimersByTimeAsync(1_000);
        const outcome = await inFlight;

        expect(observedAbort).toBe(true);
        expect(outcome.success).toBe(false);
        if (!outcome.success) {
          expect(outcome.error.message).toContain('Reaction invocation deadline reached');
        }
        // Settled invocations must leave no timers or listeners behind.
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('honors deadlines beyond the platform timer cap by rescheduling instead of aborting early', async () => {
      const timerCapMs = 2_147_483_647;
      vi.useFakeTimers();
      try {
        registry.register('alpha', [
          makeNotifyReaction('alpha', async (_parameters, context) => {
            await new Promise<void>((resolve) => {
              context.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            throw context.signal.reason;
          }),
        ]);

        const inFlight = registry.invoke(
          'alpha.notify',
          { message: 'hi' },
          makeInput({ deadlineEpochMs: Date.now() + timerCapMs + 5_000 }),
        );
        // At the cap the timer must wake up, re-check, and reschedule — NOT abort.
        await vi.advanceTimersByTimeAsync(timerCapMs);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(5_000);
        const outcome = await inFlight;

        expect(outcome.success).toBe(false);
        if (!outcome.success) {
          expect(outcome.error.message).toContain('Reaction invocation deadline reached');
        }
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats a non-finite deadline as no deadline', async () => {
      vi.useFakeTimers();
      try {
        const handler = vi.fn(async () => {});
        registry.register('alpha', [makeNotifyReaction('alpha', handler)]);

        for (const deadlineEpochMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          const outcome = await registry.invoke('alpha.notify', { message: 'hi' }, makeInput({ deadlineEpochMs }));
          expect(outcome).toEqual({ success: true });
        }
        expect(handler).toHaveBeenCalledTimes(3);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives each invocation its own signal, distinct from the host signal', async () => {
      const hostController = new AbortController();
      const seenSignals: AbortSignal[] = [];
      registry.register('alpha', [
        makeNotifyReaction('alpha', (_parameters, context) => {
          seenSignals.push(context.signal);
        }),
      ]);

      await registry.invoke('alpha.notify', { message: 'a' }, makeInput({ hostSignal: hostController.signal }));
      await registry.invoke('alpha.notify', { message: 'b' }, makeInput({ hostSignal: hostController.signal }));

      expect(seenSignals).toHaveLength(2);
      expect(seenSignals[0]).not.toBe(hostController.signal);
      expect(seenSignals[1]).not.toBe(hostController.signal);
      expect(seenSignals[0]).not.toBe(seenSignals[1]);
    });

    it('propagates a mid-flight host abort into the per-invocation signal', async () => {
      const hostController = new AbortController();
      registry.register('alpha', [
        makeNotifyReaction('alpha', async (_parameters, context) => {
          hostController.abort(new Error('host shutdown'));
          if (context.signal.aborted) {
            throw context.signal.reason;
          }
        }),
      ]);

      const outcome = await registry.invoke(
        'alpha.notify',
        { message: 'hi' },
        makeInput({ hostSignal: hostController.signal }),
      );

      expect(outcome).toEqual({ success: false, error: { message: 'host shutdown' } });
    });

    it('keeps concurrent invocation IDs and cancellation isolated', async () => {
      const firstController = new AbortController();
      const secondController = new AbortController();
      let releaseSecond: (() => void) | undefined;
      const secondDone = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const contexts = new Map<boolean, ReactionExecutionContext>();
      registry.register('alpha', [
        defineReaction({
          kind: 'alpha.race',
          description: 'Waits or reacts to cancellation per parameters.',
          parameterSchema: z.object({ wait: z.boolean() }),
          handler: async (parameters, context) => {
            contexts.set(parameters.wait, context);
            if (!parameters.wait) {
              await new Promise<void>((resolve) => {
                context.signal.addEventListener('abort', () => resolve(), { once: true });
              });
              throw context.signal.reason;
            }
            await secondDone;
          },
        }),
      ]);

      const cancelled = registry.invoke(
        'alpha.race',
        { wait: false },
        makeInput({ hostSignal: firstController.signal }),
      );
      const succeeding = registry.invoke(
        'alpha.race',
        { wait: true },
        makeInput({ hostSignal: secondController.signal }),
      );

      await vi.waitFor(() => expect(contexts).toHaveLength(2));
      firstController.abort(new Error('first cancelled'));

      await expect(cancelled).resolves.toEqual({ success: false, error: { message: 'first cancelled' } });
      const firstContext = contexts.get(false);
      const secondContext = contexts.get(true);
      expect(firstContext?.invocationId).not.toBe(secondContext?.invocationId);
      expect(firstContext?.signal).not.toBe(secondContext?.signal);
      expect(secondContext?.signal.aborted).toBe(false);
      releaseSecond?.();
      await expect(succeeding).resolves.toEqual({ success: true });
    });

    it('removes the host abort listener after the invocation settles', async () => {
      const hostController = new AbortController();
      const addListener = vi.spyOn(hostController.signal, 'addEventListener');
      const removeListener = vi.spyOn(hostController.signal, 'removeEventListener');
      registry.register('alpha', [makeNotifyReaction('alpha')]);

      await expect(
        registry.invoke('alpha.notify', { message: 'hi' }, makeInput({ hostSignal: hostController.signal })),
      ).resolves.toEqual({ success: true });

      expect(addListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(removeListener).toHaveBeenCalledWith('abort', addListener.mock.calls[0]?.[1]);
    });

    it('freezes the invocation envelope while retaining host-owned references', async () => {
      const ruleRef = createReactionRuleRef({ ruleId: 'rule-7' });
      const eventPayload = { changed: true };
      const hostContext = { workspace: '/tmp/ws' };
      const deadlineEpochMs = Date.now() + 60_000;
      let seen: ReactionExecutionContext | undefined;
      registry.register('alpha', [
        makeNotifyReaction('alpha', (_parameters, context) => {
          seen = context;
        }),
      ]);

      const outcome = await registry.invoke(
        'alpha.notify',
        { message: 'hi' },
        makeInput({
          eventKind: 'fs.changed',
          eventPayload,
          hostContext,
          ruleRef,
          correlationId: 'corr-9',
          deadlineEpochMs,
        }),
      );

      expect(outcome).toEqual({ success: true });
      expect(seen).toBeDefined();
      expect(Object.isFrozen(seen)).toBe(true);
      expect(seen?.eventKind).toBe('fs.changed');
      // Host-owned values are passed through verbatim; the runtime does not
      // deep-clone or freeze them for the handler.
      expect(seen?.eventPayload).toBe(eventPayload);
      expect(seen?.hostContext).toBe(hostContext);
      expect(seen?.ruleRef).toBe(ruleRef);
      expect(seen?.correlationId).toBe('corr-9');
      expect(seen?.deadlineEpochMs).toBe(deadlineEpochMs);
      expect(typeof seen?.invocationId).toBe('string');
      expect(seen?.invocationId.length).toBeGreaterThan(0);
      expect(seen?.signal.aborted).toBe(false);
    });

    it('captures the top-level invocation envelope before async parameter validation', async () => {
      let releaseValidation: (() => void) | undefined;
      const validationGate = new Promise<void>((resolve) => {
        releaseValidation = resolve;
      });
      let markValidationStarted: (() => void) | undefined;
      const validationStarted = new Promise<void>((resolve) => {
        markValidationStarted = resolve;
      });
      let seen: ReactionExecutionContext | undefined;
      registry.register('alpha', [
        defineReaction({
          kind: 'alpha.async-envelope',
          description: 'Waits while its invocation envelope could otherwise be reassigned.',
          parameterSchema: z.object({ message: z.string() }).refine(async () => {
            markValidationStarted?.();
            await validationGate;
            return true;
          }),
          handler: async (_parameters, context) => {
            seen = context;
            throw new Error('handler failed after validation');
          },
        }),
      ]);

      const originalPayload = { version: 'original' };
      const originalHostContext = { workspace: '/original' };
      const originalRuleRef = createReactionRuleRef({ ruleId: 'original-rule' });
      const originalDeadlineEpochMs = Date.now() + 60_000;
      const input = {
        eventKind: 'original.event',
        eventPayload: originalPayload,
        hostContext: originalHostContext,
        ruleRef: originalRuleRef,
        correlationId: 'original-correlation',
        deadlineEpochMs: originalDeadlineEpochMs,
      } satisfies ReactionInvocationInput;

      const invocation = registry.invoke('alpha.async-envelope', { message: 'hi' }, input);
      await validationStarted;
      input.eventKind = 'mutated.event';
      input.eventPayload = { version: 'mutated' };
      input.hostContext = { workspace: '/mutated' };
      input.ruleRef = createReactionRuleRef({ ruleId: 'mutated-rule' });
      input.correlationId = 'mutated-correlation';
      input.deadlineEpochMs = Date.now() + 120_000;
      releaseValidation?.();

      await expect(invocation).resolves.toEqual({
        success: false,
        error: { message: 'handler failed after validation' },
      });
      expect(seen).toMatchObject({
        eventKind: 'original.event',
        correlationId: 'original-correlation',
        deadlineEpochMs: originalDeadlineEpochMs,
      });
      expect(seen?.eventPayload).toBe(originalPayload);
      expect(seen?.hostContext).toBe(originalHostContext);
      expect(seen?.ruleRef).toBe(originalRuleRef);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('(correlationId: original-correlation)'),
        expect.any(Error),
      );
    });
  });

  describe('destroy', () => {
    it('clears all registrations on teardown', async () => {
      registry.register('alpha', [makeNotifyReaction('alpha')]);

      await registry.destroy();

      expect(registry.listDescriptors()).toEqual([]);
    });
  });

  describe('listDescriptors', () => {
    it('returns serializable descriptors for all registered Reactions', () => {
      registry.register('alpha', [makeNotifyReaction('alpha')]);
      registry.register('beta', [makeNotifyReaction('beta')]);

      const descriptors = registry.listDescriptors();

      expect(descriptors.map((descriptor) => descriptor.kind).sort()).toEqual(['alpha.notify', 'beta.notify']);
      expect(descriptors[0]?.description).toBe('Notifies someone.');
      expect(descriptors[0]?.parameterSchema).toMatchObject({
        type: 'object',
        properties: { message: { type: 'string' } },
      });
    });

    it('describes a transformed schema while invoking its handler with transformed parameters', async () => {
      const handler = vi.fn(async () => {});
      registry.register('alpha', [
        defineReaction({
          kind: 'alpha.normalize',
          description: 'Normalizes a message before handling it.',
          parameterSchema: z.object({ message: z.string() }).transform(({ message }) => ({
            message: message.trim().toUpperCase(),
          })),
          handler,
        }),
      ]);

      expect(registry.listDescriptors()).toHaveLength(1);
      await expect(registry.invoke('alpha.normalize', { message: ' hello ' }, makeInput())).resolves.toEqual({
        success: true,
      });
      expect(handler).toHaveBeenCalledWith({ message: 'HELLO' }, expect.objectContaining({ eventKind: 'test.event' }));
    });

    it('returns detached descriptor snapshots', () => {
      registry.register('alpha', [makeNotifyReaction('alpha')]);
      const descriptor = registry.listDescriptors()[0];
      if (!descriptor) throw new Error('Expected the registered Reaction descriptor.');
      descriptor.parameterSchema.properties = { message: { type: 'number' } };

      expect(registry.listDescriptors()[0]?.parameterSchema).toMatchObject({
        properties: { message: { type: 'string' } },
      });
    });

    it('does not call an extension descriptor factory after registration', () => {
      const toDescriptor = vi.fn(() => ({
        kind: 'alpha.custom',
        description: 'Custom descriptor.',
        parameterSchema: {},
      }));
      registry.register('alpha', [
        {
          kind: 'alpha.custom',
          description: 'Custom descriptor.',
          parameterSchema: z.object({}),
          handler: async () => {},
          toDescriptor,
        },
      ]);

      expect(toDescriptor).toHaveBeenCalledTimes(1);
      registry.listDescriptors();
      registry.listDescriptors();
      expect(toDescriptor).toHaveBeenCalledTimes(1);
    });
  });
});
