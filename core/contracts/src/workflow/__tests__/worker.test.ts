import { describe, expect, expectTypeOf, it } from 'vitest';
import type { JsonValue } from '../../shared/index.js';
import {
  WorkflowRunResultSchema,
  WorkerContributionManifestSchema,
  type WorkflowRunResult,
  type WorkerContributionManifest,
  type WorkerContributionPackageRef,
} from '../worker.js';
import { WorkflowRunContextSchema, WorkflowWorkerConfigSchema } from '../index.js';

describe('WorkflowRunResult', () => {
  it('types output as JSON-safe data', () => {
    expectTypeOf<WorkflowRunResult['output']>().toEqualTypeOf<JsonValue | undefined>();

    const result: WorkflowRunResult = {
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'completed',
      output: { approved: true },
    };

    expect(result.output).toEqual({ approved: true });
  });

  it('requires pause identity only for paused results', () => {
    const paused: WorkflowRunResult = {
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'paused',
      pausedAtGateId: 'approve',
      pausedAtFrameId: 'frame-approve-1',
    };
    const completed: WorkflowRunResult = {
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'completed',
    };

    // @ts-expect-error paused results must identify the suspended gate.
    const missingFrame: WorkflowRunResult = {
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'paused',
      pausedAtGateId: 'approve',
    };
    // @ts-expect-error non-paused results cannot carry pause identity.
    const completedWithPauseIdentity: WorkflowRunResult = {
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'completed',
      pausedAtGateId: 'approve',
    };

    expect(paused.pausedAtFrameId).toBe('frame-approve-1');
    expect(completed.status).toBe('completed');
    expect(missingFrame.status).toBe('paused');
    expect(completedWithPauseIdentity.status).toBe('completed');
  });
});

describe('WorkerContributionManifestSchema', () => {
  it('validates worker contribution manifests as JSON-safe package refs', () => {
    const manifest = WorkerContributionManifestSchema.parse({
      packages: [{ name: '@acme/workflow-tools', importPath: '@acme/workflow-tools/server' }],
    });

    expect(manifest.packages[0]).toEqual({
      name: '@acme/workflow-tools',
      importPath: '@acme/workflow-tools/server',
    });
  });

  it('exports manifest types from contracts', () => {
    const ref: WorkerContributionPackageRef = {
      name: '@acme/workflow-tools',
      importPath: '@acme/workflow-tools/server',
    };
    const manifest: WorkerContributionManifest = { packages: [ref] };

    expect(manifest.packages[0]?.importPath).toBe('@acme/workflow-tools/server');
  });

  it('defaults packages to an empty array when omitted', () => {
    const manifest = WorkerContributionManifestSchema.parse({});
    expect(manifest.packages).toEqual([]);
  });

  it('rejects package refs with empty name', () => {
    expect(() =>
      WorkerContributionManifestSchema.parse({
        packages: [{ name: '', importPath: '@acme/workflow-tools/server' }],
      }),
    ).toThrow();
  });

  it('rejects package refs with empty importPath', () => {
    expect(() =>
      WorkerContributionManifestSchema.parse({
        packages: [{ name: '@acme/workflow-tools', importPath: '' }],
      }),
    ).toThrow();
  });
});

describe('WorkflowRunResultSchema', () => {
  it('validates serializable workflow run results', () => {
    const result = WorkflowRunResultSchema.parse({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'completed',
      output: { ok: true },
    });

    expect(result.output).toEqual({ ok: true });
  });

  it('accepts all terminal statuses', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      const result = WorkflowRunResultSchema.parse({
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status,
      });
      expect(result.status).toBe(status);
    }
  });

  it('rejects unknown status values', () => {
    expect(() =>
      WorkflowRunResultSchema.parse({
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'running',
      }),
    ).toThrow();
  });

  it('rejects missing executionId', () => {
    expect(() =>
      WorkflowRunResultSchema.parse({
        workflowId: 'wf-1',
        status: 'completed',
      }),
    ).toThrow();
  });

  it('accepts paused worker results with frame-aware gate identity', () => {
    expect(
      WorkflowRunResultSchema.parse({
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'paused',
        pausedAtGateId: 'approve',
        pausedAtFrameId: 'frame-approve-1',
      }),
    ).toMatchObject({ status: 'paused', pausedAtFrameId: 'frame-approve-1' });
  });

  it('rejects paused result without pausedAtGateId', () => {
    expect(() =>
      WorkflowRunResultSchema.parse({
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'paused',
        pausedAtFrameId: 'frame-1',
      }),
    ).toThrow();
  });

  it('rejects paused result without pausedAtFrameId', () => {
    expect(() =>
      WorkflowRunResultSchema.parse({
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'paused',
        pausedAtGateId: 'gate-1',
      }),
    ).toThrow();
  });

  it('rejects non-paused results with pause identity', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(() =>
        WorkflowRunResultSchema.parse({
          executionId: 'wfx-1',
          workflowId: 'wf-1',
          status,
          pausedAtGateId: 'gate-1',
          pausedAtFrameId: 'frame-1',
        }),
      ).toThrow();
    }
  });
});

describe('suspension strategy in WorkflowWorkerConfigSchema and WorkflowRunContextSchema', () => {
  it('carries selected suspension strategy through worker config and run context', () => {
    const config = WorkflowWorkerConfigSchema.parse({
      source: { kind: 'definition', workflowId: 'wf-1' },
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      inputs: {},
      triggerPayload: {},
      scope: { type: 'global' },
      context: { repoPath: '/repo', makaioHome: '/home/.makaio', os: 'linux', arch: 'arm64' },
      env: {},
      coordinatorSessionId: 'session-1',
      cancelSubject: 'workflow.wfx-1.cancel',
      suspensionStrategy: 'exit-and-redispatch',
    });
    const runContext = WorkflowRunContextSchema.parse({
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      source: { kind: 'path', path: '/repo/workflow.ts' },
      workerManifest: { packages: [] },
      inputs: {},
      scope: { type: 'global' },
      triggerPayload: {},
      coordinatorSessionId: 'session-1',
      cancelSubject: 'workflow.wfx-1.cancel',
      context: { repoPath: '/repo', makaioHome: '/home/.makaio', os: 'linux', arch: 'arm64' },
      env: {},
      createdAt: 1,
      suspensionStrategy: 'exit-and-redispatch',
    });

    expect(config.suspensionStrategy).toBe('exit-and-redispatch');
    expect(runContext.suspensionStrategy).toBe('exit-and-redispatch');
  });
});
