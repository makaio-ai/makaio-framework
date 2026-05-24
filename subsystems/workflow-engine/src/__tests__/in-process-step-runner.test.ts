import { describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { InProcessStepRunner } from '../in-process-step-runner.js';
import { WorkflowGateCoordinator } from '../workflow-gate-coordinator.js';
import { DEFAULT_EXECUTOR_CONFIG } from '../types.js';

describe('InProcessStepRunner', () => {
  it('returns failed result when no active execution exists', async () => {
    const bus = createBusInstance();
    const runner = new InProcessStepRunner({
      bus,
      activeExecutions: new Map(),
      shellAbortControllers: new Map(),
      gateCoordinator: new WorkflowGateCoordinator(bus),
      config: { ...DEFAULT_EXECUTOR_CONFIG, stepCooldownMs: 0 },
    });

    const result = await runner.run(
      {
        executionId: 'missing',
        workflowId: 'workflow',
        stepId: 'one',
        coordinatorSessionId: 'sess-1',
        stepType: 'shell',
        stepDefinition: { id: 'one', type: 'shell', command: ['echo', 'ok'] },
        resolvedInputs: {},
        busAuth: { kind: 'none' },
        platformDefaults: { cwd: '/tmp' },
        cancelSubject: 'workflow.missing.step.one.cancel',
      },
      AbortSignal.abort(),
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Active execution not found: missing');
    expect(result.telemetry.duration).toEqual(expect.any(Number));
    vi.restoreAllMocks();
  });
});
