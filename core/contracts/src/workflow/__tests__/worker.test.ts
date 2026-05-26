import { describe, expect, expectTypeOf, it } from 'vitest';
import type { JsonValue } from '../../shared/index.js';
import {
  WorkflowRunResultSchema,
  WorkerContributionManifestSchema,
  type WorkflowRunResult,
  type WorkerContributionManifest,
  type WorkerContributionPackageRef,
} from '../worker.js';

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
});
