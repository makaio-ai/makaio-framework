import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusInstance } from '@makaio/bus-core';
import { WorkerNamespace, WorkerSubjects } from '@makaio/contracts';
import { ExtensionCoordinator } from '@makaio/kernel';
import { buildWorkflowAttemptInstruction } from '@makaio/subsystem-workflow-engine';
import { describe, expect, it, vi } from 'vitest';
import type { HeadlessWorkflowWorkerDeps } from '../headless-workflow-worker.js';
import { createIsolatedWorkflowRuntime, type IsolatedWorkflowRuntime } from '../isolated-workflow-runtime.js';
import { createWorkflowWorkloadAdapter } from '../workflow-workload-adapter.js';
import { makeWorkerConfig } from './fixtures.js';

vi.mock('../isolated-workflow-runtime.js', () => ({ createIsolatedWorkflowRuntime: vi.fn() }));

const config = makeWorkerConfig({
  definition: {
    id: 'workflow-1',
    name: 'Shutdown regression',
    root: { id: 'root', type: 'sequence', nodes: [] },
    scope: { type: 'global' },
  },
});
const credentials = { busUrl: 'ws://localhost/bus', busAuthSecret: 'test-secret' };

/**
 * Supply the adapter's existing seams with an empty, read-only runtime configuration.
 * @param execute - Execution behavior exercised before runtime shutdown.
 * @returns Minimal installed workflow dependencies.
 */
function makeDependencies(execute: HeadlessWorkflowWorkerDeps['execute']): HeadlessWorkflowWorkerDeps {
  return {
    executionId: config.executionId,
    executionAttemptId: 'attempt-1',
    bootstrapDeadlineAt: new Date(Date.now() + 120_000).toISOString(),
    workflowEnv: {},
    bootstrap: async () => credentials,
    connectBus: async () => {},
    materialize: async () => ({
      context: {
        workspaceRoot: tmpdir(),
        sourcePath: join(tmpdir(), 'workflow.ts'),
        contributionEntrypoints: [],
        platform: 'linux',
        arch: 'x64',
      },
    }),
    loadContributions: async () => [],
    execute,
    configRepository: {
      loadAdapterConfigs: async () => ({ configs: new Map() }),
      loadProviderConfigs: async () => ({ configs: new Map() }),
      async writeProviderConfig(): Promise<void> {
        throw new Error('read only');
      },
      async deleteProviderConfig(): Promise<boolean> {
        throw new Error('read only');
      },
      async writeAdapterFile(): Promise<void> {
        throw new Error('read only');
      },
      async deleteAdapterFile(): Promise<boolean> {
        throw new Error('read only');
      },
    },
    toolsets: [],
  };
}

describe('workflow workload adapter shutdown', () => {
  it.each([
    { execution: 'succeeds', executionError: undefined },
    { execution: 'throws', executionError: new Error('Execution failed') },
  ])('rejects with the shutdown error when execution $execution', async ({ executionError }) => {
    const controlBus = createBusInstance();
    controlBus.registerNamespace(WorkerNamespace);
    const offInputs = controlBus.on(WorkerSubjects.runtime.inputs.get, (ctx) => {
      expect(ctx.payload.executionAttemptId).toBe('attempt-1');
      ctx.setResult({
        runtimeInputs: { workerManifest: { contributionRefs: [] }, suspensionStrategy: 'wait-in-process' },
      });
    });
    const runtimeBus = createBusInstance();
    const shutdownError = new Error('Runtime shutdown failed');
    const shutdown = vi.fn<IsolatedWorkflowRuntime['shutdown']>().mockRejectedValue(shutdownError);
    vi.mocked(createIsolatedWorkflowRuntime).mockResolvedValue({
      bus: runtimeBus,
      coordinator: new ExtensionCoordinator(runtimeBus),
      machineId: 'test-runtime',
      shutdown,
    });
    const execute = vi.fn<HeadlessWorkflowWorkerDeps['execute']>(async () => {
      if (executionError !== undefined) throw executionError;
      return { executionId: config.executionId, workflowId: config.workflowId, status: 'completed' };
    });
    const { adapter } = createWorkflowWorkloadAdapter(makeDependencies(execute), credentials, controlBus);
    const instruction = buildWorkflowAttemptInstruction({
      id: 'instruction-1',
      revision: '1',
      config,
      preservation: { required: [] },
    });

    try {
      await expect(adapter.invoke({ instruction })).rejects.toBe(shutdownError);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[0]).toBe(runtimeBus);
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      offInputs();
      await Promise.all([controlBus.disconnect(), runtimeBus.disconnect()]);
      vi.mocked(createIsolatedWorkflowRuntime).mockReset();
    }
  });
});
