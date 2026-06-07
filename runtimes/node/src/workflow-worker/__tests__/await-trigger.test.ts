import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import type { WorkflowDefinition, WorkflowWorkerConfig } from '@makaio/contracts';
import { z } from 'zod';
import { resolveAwaitTriggerConfig } from '../await-trigger.js';

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
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    context: {
      repoPath: '/repo',
      makaioHome: '/home/.makaio',
      os: 'linux',
      arch: 'x64',
    },
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

describe('resolveAwaitTriggerConfig', () => {
  it('cleans up established subscriptions when later trigger setup fails', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(createBusNamespace('demo', { started: z.object({}) }));
    const originalOn = bus.on.bind(bus);
    const firstUnsubscribe = vi.fn();
    vi.spyOn(bus, 'on').mockImplementationOnce((subject, handler, options) => {
      const unsubscribe = originalOn(subject, handler, options);
      return () => {
        firstUnsubscribe();
        unsubscribe();
      };
    });

    await expect(
      resolveAwaitTriggerConfig(
        makeConfig(),
        {
          definition: makeDefinition({
            triggers: [
              { type: 'bus-event', subject: 'demo.started' },
              { type: 'bus-event', subject: 'invalid' },
            ],
          }),
          runtimeHandlers: new Map(),
        },
        bus,
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid trigger subject: invalid');

    expect(firstUnsubscribe).toHaveBeenCalledOnce();
  });
});
