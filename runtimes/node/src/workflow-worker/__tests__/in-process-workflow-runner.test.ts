import { describe, it, expect } from 'vitest';
import type { WorkflowDefinition, WorkflowWorkerConfig } from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import { z } from 'zod';
import { InProcessWorkflowRunner } from '../in-process-workflow-runner.js';
import { makeBusWithStorage } from './fixtures.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link WorkflowDefinition} for testing.
 * @param overrides - Partial overrides merged on top of defaults.
 * @returns A valid WorkflowDefinition stub.
 */
function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-unit-001',
    name: 'Unit Test Workflow',
    root: { id: 'wf-unit-001__root', type: 'sequence', nodes: [] },
    scope: { type: 'global' as const },
    ...overrides,
  };
}

/**
 * Build a minimal {@link WorkflowWorkerConfig} backed by an inline definition.
 *
 * Using `source.kind === 'definition'` with a populated `definition` avoids any
 * file-system access in unit tests while still exercising the real loader and
 * orchestrator paths.
 * @param overrides - Partial overrides merged on top of defaults.
 * @returns A valid WorkflowWorkerConfig stub.
 */
function makeConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'wf-unit-001' },
    executionId: 'exec-unit-001',
    workflowId: 'wf-unit-001',
    definition: makeDefinition(),
    triggerPayload: { event: 'manual' },
    inputs: {},
    scope: { type: 'global' as const },
    busAuth: { kind: 'none' },
    env: {},
    coordinatorSessionId: 'session-unit-001',
    cancelSubject: 'workflow.cancel.wf-unit-001',
    suspensionStrategy: 'wait-in-process',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InProcessWorkflowRunner', () => {
  it('returns { state: uncommitted, result } for a zero-step workflow', async () => {
    const [bus, cleanup] = makeBusWithStorage();
    try {
      const runner = new InProcessWorkflowRunner({ bus });
      const result = await runner.run(makeConfig(), new AbortController().signal);

      expect(result).toEqual({
        state: 'uncommitted',
        result: {
          executionId: 'exec-unit-001',
          workflowId: 'wf-unit-001',
          status: 'completed',
        },
      });
    } finally {
      cleanup();
    }
  });

  it('rejects with a schema error when workflowId is the wrong type', async () => {
    const [bus, cleanup] = makeBusWithStorage();
    try {
      const runner = new InProcessWorkflowRunner({ bus });
      const signal = new AbortController().signal;
      const invalidConfig = makeConfig();
      Object.assign(invalidConfig, { workflowId: 123 });

      await expect(runner.run(invalidConfig, signal)).rejects.toThrow();
    } finally {
      cleanup();
    }
  });

  it('rejects when definition-sourced config has no definition field', async () => {
    const [bus, cleanup] = makeBusWithStorage();
    try {
      const runner = new InProcessWorkflowRunner({ bus });
      // Omit definition — loadWorkflowFromConfig throws before reaching the orchestrator.
      const config = makeConfig({ definition: undefined });

      await expect(runner.run(config, new AbortController().signal)).rejects.toThrow(
        "missing the required 'definition' field",
      );
    } finally {
      cleanup();
    }
  });

  it('rejects when the abort signal fires while awaiting a bus-event trigger', async () => {
    const [bus, cleanup] = makeBusWithStorage();
    try {
      bus.registerNamespace(createBusNamespace('demo', { started: z.object({ buildId: z.string() }) }));
      const runner = new InProcessWorkflowRunner({ bus });
      const controller = new AbortController();

      const runPromise = runner.run(
        makeConfig({
          triggerPayload: {},
          definition: makeDefinition({
            triggers: [{ type: 'bus-event', subject: 'demo.started' }],
          }),
        }),
        controller.signal,
      );

      // Abort after the runner has suspended waiting for the trigger.
      await Promise.resolve();
      controller.abort('test-abort');

      await expect(runPromise).rejects.toBe('test-abort');
    } finally {
      cleanup();
    }
  });

  it('waits for a bus-event trigger and passes its payload to the orchestrator', async () => {
    const [bus, cleanup] = makeBusWithStorage();
    try {
      const { subjects } = bus.registerNamespace(
        createBusNamespace('demo', { started: z.object({ buildId: z.string() }) }),
      );
      const runner = new InProcessWorkflowRunner({ bus });

      const runPromise = runner.run(
        makeConfig({
          triggerPayload: {},
          definition: makeDefinition({
            triggers: [{ type: 'bus-event', subject: 'demo.started' }],
          }),
        }),
        new AbortController().signal,
      );

      await Promise.resolve();
      await bus.emit(subjects.started, { buildId: 'build-001' });

      const result = await runPromise;
      expect(result.state).toBe('uncommitted');
      expect(result.result.status).toBe('completed');
    } finally {
      cleanup();
    }
  });
});
