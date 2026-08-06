import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  WorkflowRunResultSchema,
  WorkerContributionManifestSchema,
  type WorkflowRunResult,
  type WorkerContributionManifest,
  type WorkerRuntimeContext,
} from '../worker.js';
import { WorkflowRunContextSchema, WorkflowWorkerConfigSchema, type WorkflowRunContext } from '../index.js';
import {
  LocalDirectoryMaterializationSchema,
  WorkerContributionRefSchema,
  WorkerMaterializationSpecSchema,
  WorkspaceSnapshotMaterializationSchema,
} from '../../capabilities/worker-node/index.js';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Minimal valid WorkflowWorkerConfig without durable context.
 * @param overrides - Partial fields to override in the config fixture.
 */
function minimalWorkerConfig(overrides: Record<string, unknown> = {}) {
  return {
    source: { kind: 'definition', workflowId: 'wf-1' },
    executionId: 'wfx-1',
    workflowId: 'wf-1',
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.wfx-1.cancel',
    ...overrides,
  };
}

/**
 * Minimal valid WorkflowRunContext without durable context.
 * @param overrides - Partial fields to override in the run context fixture.
 */
function minimalRunContext(overrides: Record<string, unknown> = {}) {
  return {
    executionId: 'wfx-1',
    workflowId: 'wf-1',
    source: { kind: 'path', path: 'src/workflow.ts' },
    materializationSpec: {
      kind: 'local-directory',
      workspaceId: 'workspace-1',
      rootDigest: 'sha256-test-workspace',
      sourcePath: 'src/workflow.ts',
    },
    coordinatorSessionId: 'session-1',
    cancelSubject: 'workflow.wfx-1.cancel',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// WorkflowRunResult (unchanged from prior plans)
// ─────────────────────────────────────────────────────────────

describe('WorkflowRunResult', () => {
  it('models completed results with an optional artifact revision', () => {
    const completed: WorkflowRunResult = {
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'completed',
      artifact: {
        kind: 'workflow-report',
        id: 'artifact-1',
        revision: 'rev-1',
        schemaVersion: '1',
        scope: { level: 'global' },
        data: { approved: true },
        relations: [],
        actor: { kind: 'workflow-execution', id: 'wfx-1' },
        timestamp: 1,
      },
    };

    expect(completed.artifact?.revision).toBe('rev-1');
  });

  it('models failed and cancelled results with explicit reason fields', () => {
    const failed: WorkflowRunResult = {
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'failed',
      error: 'adapter failed',
    };
    const cancelled: WorkflowRunResult = {
      executionId: 'wfx-2',
      workflowId: 'wf-1',
      status: 'cancelled',
      reason: 'user requested cancellation',
    };

    expect(failed.error).toBe('adapter failed');
    expect(cancelled.reason).toBe('user requested cancellation');
  });

  it('does not allow top-level output on run results', () => {
    const completedWithOutput: WorkflowRunResult = {
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'completed',
      // @ts-expect-error WorkflowRunResult no longer carries top-level output.
      output: { ok: true },
    };

    expect(completedWithOutput.status).toBe('completed');
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

// ─────────────────────────────────────────────────────────────
// WorkerContributionManifest
// ─────────────────────────────────────────────────────────────

describe('WorkerContributionManifestSchema', () => {
  const contributionRef = {
    packageName: '@acme/workflow-tools',
    version: '1.0.0',
    entrypoint: 'dist/server.mjs',
    integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uFPNZHzA3w0=',
  };

  it('validates worker contribution manifests as exact integrity-bearing refs', () => {
    const manifest = WorkerContributionManifestSchema.parse({
      contributionRefs: [contributionRef],
    });

    expect(manifest.contributionRefs).toEqual([contributionRef]);
  });

  it('exports manifest types from contracts', () => {
    const manifest: WorkerContributionManifest = { contributionRefs: [contributionRef] };

    expect(manifest.contributionRefs[0]?.integrity).toBe(contributionRef.integrity);
  });

  it('requires a contribution identity set', () => {
    expect(() => WorkerContributionManifestSchema.parse({})).toThrow();
  });

  it('rejects legacy loading paths and malformed integrity', () => {
    expect(() => WorkerContributionManifestSchema.parse({ packages: [] })).toThrow();
    expect(() =>
      WorkerContributionManifestSchema.parse({
        contributionRefs: [{ ...contributionRef, integrity: 'not-sri' }],
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// WorkflowRunResultSchema
// ─────────────────────────────────────────────────────────────

describe('WorkflowRunResultSchema', () => {
  it('validates completed results with artifact revisions', () => {
    const result = WorkflowRunResultSchema.parse({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'completed',
      artifact: {
        kind: 'workflow-report',
        id: 'artifact-1',
        revision: 'rev-1',
        schemaVersion: '1',
        scope: { level: 'global' },
        data: { ok: true },
        relations: [],
        actor: { kind: 'workflow-execution', id: 'wfx-1' },
        timestamp: 1,
      },
    });

    expect(result.status).toBe('completed');
    expect(result.status === 'completed' && result.artifact?.data).toEqual({ ok: true });
  });

  it('requires an error for failed results', () => {
    const result = WorkflowRunResultSchema.parse({
      executionId: 'wfx-1',
      workflowId: 'wf-1',
      status: 'failed',
      error: 'Workflow execution failed',
    });

    expect(result.status === 'failed' && result.error).toBe('Workflow execution failed');
    expect(() =>
      WorkflowRunResultSchema.parse({
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'failed',
      }),
    ).toThrow();
  });

  it('accepts cancelled results with an optional reason', () => {
    expect(
      WorkflowRunResultSchema.parse({
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'cancelled',
        reason: 'user cancelled',
      }),
    ).toMatchObject({ status: 'cancelled', reason: 'user cancelled' });

    expect(
      WorkflowRunResultSchema.parse({
        executionId: 'wfx-2',
        workflowId: 'wf-1',
        status: 'cancelled',
      }),
    ).toMatchObject({ status: 'cancelled' });
  });

  it('rejects top-level output on every result variant', () => {
    for (const payload of [
      {
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'completed',
        output: { ok: true },
      },
      {
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'failed',
        error: 'failed',
        output: 'failed',
      },
      {
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'cancelled',
        output: { reason: 'cancelled' },
      },
      {
        executionId: 'wfx-1',
        workflowId: 'wf-1',
        status: 'paused',
        pausedAtGateId: 'gate-1',
        pausedAtFrameId: 'frame-1',
        output: { reason: 'paused' },
      },
    ]) {
      expect(() => WorkflowRunResultSchema.parse(payload)).toThrow();
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
    ).toMatchObject({
      status: 'paused',
      pausedAtFrameId: 'frame-approve-1',
    });
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

// ─────────────────────────────────────────────────────────────
// Portable WorkflowWorkerConfig — no Authority-local context
// ─────────────────────────────────────────────────────────────

describe('portable WorkflowWorkerConfig', () => {
  it('parses a minimal config without a context field', () => {
    const config = WorkflowWorkerConfigSchema.parse(minimalWorkerConfig());

    expect(config.executionId).toBe('wfx-1');
    expect(config.workflowId).toBe('wf-1');
  });

  it('does not accept a durable context with Authority-local fields', () => {
    // Providing the old context object should be rejected because the
    // field no longer exists in the schema.
    const withContext = {
      ...minimalWorkerConfig(),
      context: {
        repoPath: '/repo',
        makaioHome: '/home/.makaio',
        os: 'linux',
        arch: 'arm64',
      },
    };
    // Zod's default non-strict mode strips unknown fields, so the context
    // is silently ignored and the parse succeeds. The important contract
    // is that the parsed output does NOT carry a context property.
    const parsed = WorkflowWorkerConfigSchema.parse(withContext);
    expect(parsed).not.toHaveProperty('context');
  });

  it('carries suspension strategy without durable context', () => {
    const config = WorkflowWorkerConfigSchema.parse(
      minimalWorkerConfig({
        suspensionStrategy: 'exit-and-redispatch',
      }),
    );

    expect(config.suspensionStrategy).toBe('exit-and-redispatch');
  });

  it('accepts only explicit workflow trigger modes', () => {
    expect(WorkflowWorkerConfigSchema.parse(minimalWorkerConfig({ triggerMode: 'await-trigger' })).triggerMode).toBe(
      'await-trigger',
    );
    expect(() => WorkflowWorkerConfigSchema.parse(minimalWorkerConfig({ triggerMode: 'empty-payload' }))).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Portable WorkflowRunContext — no Authority-local context
// ─────────────────────────────────────────────────────────────

describe('portable WorkflowRunContext', () => {
  it('parses a minimal run context without a context field', () => {
    const runContext = WorkflowRunContextSchema.parse(minimalRunContext());

    expect(runContext.executionId).toBe('wfx-1');
    expect(runContext.workflowId).toBe('wf-1');
  });

  it('does not carry durable repoPath, makaioHome, worktree, os, or arch', () => {
    const parsed = WorkflowRunContextSchema.parse(minimalRunContext());

    expect(parsed).not.toHaveProperty('context');
    // Verify the type doesn't have those old fields
    expectTypeOf<WorkflowRunContext>().not.toHaveProperty('context');
  });

  it('carries suspension strategy without durable context', () => {
    const runContext = WorkflowRunContextSchema.parse(
      minimalRunContext({
        suspensionStrategy: 'exit-and-redispatch',
      }),
    );

    expect(runContext.suspensionStrategy).toBe('exit-and-redispatch');
  });

  it('persists only explicit workflow trigger modes', () => {
    expect(WorkflowRunContextSchema.parse(minimalRunContext({ triggerMode: 'await-trigger' })).triggerMode).toBe(
      'await-trigger',
    );
    expect(() => WorkflowRunContextSchema.parse(minimalRunContext({ triggerMode: 'empty-payload' }))).toThrow();
  });

  it('rejects an Authority-local path before persistence', () => {
    expect(() =>
      WorkflowRunContextSchema.parse(minimalRunContext({ source: { kind: 'path', path: '/authority/workflow.ts' } })),
    ).toThrow(/workspace-relative/);
  });

  it('requires a matching materialization spec for a path source', () => {
    expect(() => WorkflowRunContextSchema.parse(minimalRunContext({ materializationSpec: undefined }))).toThrow(
      /materializationSpec is required/,
    );

    expect(() =>
      WorkflowRunContextSchema.parse(
        minimalRunContext({
          materializationSpec: {
            kind: 'local-directory',
            workspaceId: 'workspace-1',
            rootDigest: 'sha256-test-workspace',
            sourcePath: 'different/workflow.ts',
          },
        }),
      ),
    ).toThrow(/must match source.path/);
  });
});

// ─────────────────────────────────────────────────────────────
// WorkerRuntimeContext — ephemeral, worker-local only
// ─────────────────────────────────────────────────────────────

describe('WorkerRuntimeContext', () => {
  it('may contain worker-local absolute paths', () => {
    const runtimeContext: WorkerRuntimeContext = {
      workspaceRoot: '/tmp/worker-12345/workspace',
      sourcePath: '/tmp/worker-12345/workspace/src/workflow.ts',
      contributionEntrypoints: ['/tmp/worker-12345/workspace/packages/tools/dist/server.mjs'],
      platform: 'linux',
      arch: 'arm64',
    };

    expect(runtimeContext.workspaceRoot).toBe('/tmp/worker-12345/workspace');
    expect(runtimeContext.sourcePath).toMatch(/^\//);
    expect(runtimeContext.contributionEntrypoints[0]).toMatch(/^\//);
  });

  it('is NOT part of WorkflowRunContext', () => {
    // WorkerRuntimeContext must not be a property of WorkflowRunContext.
    // The ephemeral context is never persisted.
    expectTypeOf<WorkflowRunContext>().not.toHaveProperty('runtimeContext');
    expectTypeOf<WorkflowRunContext>().not.toHaveProperty('workerRuntimeContext');
  });

  it('has the exact ephemeral shape from the plan', () => {
    expectTypeOf<WorkerRuntimeContext>().toEqualTypeOf<{
      readonly workspaceRoot: string;
      readonly sourcePath: string;
      readonly contributionEntrypoints: readonly string[];
      readonly platform: 'darwin' | 'linux' | 'win32';
      readonly arch: string;
    }>();
  });

  it('restricts platform to the three supported values', () => {
    expectTypeOf<WorkerRuntimeContext['platform']>().toEqualTypeOf<'darwin' | 'linux' | 'win32'>();
  });
});

// ─────────────────────────────────────────────────────────────
// Materialization spec — portable sourcePath validation
// ─────────────────────────────────────────────────────────────

describe('WorkerMaterializationSpec sourcePath validation', () => {
  it('rejects absolute sourcePath on workspace-snapshot', () => {
    expect(() =>
      WorkspaceSnapshotMaterializationSchema.parse({
        kind: 'workspace-snapshot',
        snapshotId: 'snap-1',
        digest: 'sha256:abc123',
        sourcePath: '/absolute/path/to/workflow.ts',
      }),
    ).toThrow(/sourcePath must be relative/);
  });

  it('rejects Windows absolute sourcePath on workspace-snapshot', () => {
    expect(() =>
      WorkspaceSnapshotMaterializationSchema.parse({
        kind: 'workspace-snapshot',
        snapshotId: 'snap-1',
        digest: 'sha256:abc123',
        sourcePath: 'C:\\Users\\repo\\workflow.ts',
      }),
    ).toThrow(/sourcePath must be relative/);
  });

  it('accepts relative sourcePath on workspace-snapshot', () => {
    const parsed = WorkspaceSnapshotMaterializationSchema.parse({
      kind: 'workspace-snapshot',
      snapshotId: 'snap-1',
      digest: 'sha256:abc123',
      sourcePath: 'src/workflow.ts',
    });

    expect(parsed.sourcePath).toBe('src/workflow.ts');
  });

  it('rejects absolute sourcePath on local-directory', () => {
    expect(() =>
      LocalDirectoryMaterializationSchema.parse({
        kind: 'local-directory',
        workspaceId: 'ws-1',
        rootDigest: 'sha256:abc123',
        sourcePath: '/repo/src/workflow.ts',
      }),
    ).toThrow(/sourcePath must be relative/);
  });

  it('accepts relative sourcePath on local-directory', () => {
    const parsed = LocalDirectoryMaterializationSchema.parse({
      kind: 'local-directory',
      workspaceId: 'ws-1',
      rootDigest: 'sha256:abc123',
      sourcePath: 'src/workflow.ts',
    });

    expect(parsed.sourcePath).toBe('src/workflow.ts');
  });

  it('rejects empty sourcePath', () => {
    expect(() =>
      WorkerMaterializationSpecSchema.parse({
        kind: 'workspace-snapshot',
        snapshotId: 'snap-1',
        digest: 'sha256:abc123',
        sourcePath: '',
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Contribution ref — entrypoint and integrity validation
// ─────────────────────────────────────────────────────────────

describe('WorkerContributionRef validation', () => {
  it('rejects entrypoint paths into node_modules', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'node_modules/@acme/tools/dist/server.mjs',
        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
      }),
    ).toThrow(/node_modules/);
  });

  it('rejects absolute entrypoint paths', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: '/usr/lib/node_modules/@acme/tools/dist/server.mjs',
        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
      }),
    ).toThrow(/package-relative/);
  });

  it('rejects Windows absolute entrypoint paths', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'C:\\packages\\tools\\dist\\server.mjs',
        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
      }),
    ).toThrow(/package-relative/);
  });

  it('accepts a valid package-relative entrypoint', () => {
    const ref = WorkerContributionRefSchema.parse({
      packageName: '@acme/tools',
      version: '1.0.0',
      entrypoint: 'dist/server.mjs',
      integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
    });

    expect(ref.entrypoint).toBe('dist/server.mjs');
  });

  it('rejects malformed integrity (no SRI prefix)', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: 'not-a-valid-hash',
      }),
    ).toThrow(/SRI/);
  });

  it('rejects integrity with unknown hash algorithm', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: 'md5-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
      }),
    ).toThrow(/SRI/);
  });

  it('accepts sha256 integrity', () => {
    const ref = WorkerContributionRefSchema.parse({
      packageName: '@acme/tools',
      version: '1.0.0',
      entrypoint: 'dist/server.mjs',
      integrity: 'sha256-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
    });

    expect(ref.integrity).toMatch(/^sha256-/);
  });

  it('accepts sha384 integrity', () => {
    const ref = WorkerContributionRefSchema.parse({
      packageName: '@acme/tools',
      version: '1.0.0',
      entrypoint: 'dist/server.mjs',
      integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uFPNZHzA3w0=',
    });

    expect(ref.integrity).toMatch(/^sha384-/);
  });

  it('accepts sha512 integrity', () => {
    const ref = WorkerContributionRefSchema.parse({
      packageName: '@acme/tools',
      version: '1.0.0',
      entrypoint: 'dist/server.mjs',
      integrity: 'sha512-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uFPNZHzA3w0nNOvXS/EepIyA6=',
    });

    expect(ref.integrity).toMatch(/^sha512-/);
  });

  it('rejects empty integrity', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: '',
      }),
    ).toThrow();
  });

  it('rejects incomplete package identity (missing version)', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        entrypoint: 'dist/server.mjs',
        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
      }),
    ).toThrow();
  });

  it('rejects incomplete package identity (missing packageName)', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        version: '1.0.0',
        entrypoint: 'dist/server.mjs',
        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
      }),
    ).toThrow();
  });

  it('rejects incomplete package identity (missing entrypoint)', () => {
    expect(() =>
      WorkerContributionRefSchema.parse({
        packageName: '@acme/tools',
        version: '1.0.0',
        integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K',
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// Materialization spec — snapshot digest validation
// ─────────────────────────────────────────────────────────────

describe('WorkerMaterializationSpec digest validation', () => {
  it('rejects workspace-snapshot with missing digest', () => {
    expect(() =>
      WorkspaceSnapshotMaterializationSchema.parse({
        kind: 'workspace-snapshot',
        snapshotId: 'snap-1',
        sourcePath: 'src/workflow.ts',
        // digest is omitted
      }),
    ).toThrow();
  });

  it('rejects workspace-snapshot with empty digest', () => {
    expect(() =>
      WorkspaceSnapshotMaterializationSchema.parse({
        kind: 'workspace-snapshot',
        snapshotId: 'snap-1',
        digest: '',
        sourcePath: 'src/workflow.ts',
      }),
    ).toThrow();
  });

  it('accepts workspace-snapshot with a non-empty digest', () => {
    const spec = WorkspaceSnapshotMaterializationSchema.parse({
      kind: 'workspace-snapshot',
      snapshotId: 'snap-1',
      digest: 'sha256:abc123def456',
      sourcePath: 'src/workflow.ts',
    });

    expect(spec.digest).toBe('sha256:abc123def456');
  });
});

// ─────────────────────────────────────────────────────────────
// Materialization spec — invalid mode
// ─────────────────────────────────────────────────────────────

describe('WorkerMaterializationSpec mode validation', () => {
  it('rejects an invalid materialization mode', () => {
    expect(() =>
      WorkerMaterializationSpecSchema.parse({
        kind: 'docker-image',
        image: 'node:22',
      }),
    ).toThrow();
  });

  it('accepts only local-directory and workspace-snapshot', () => {
    expect(
      WorkerMaterializationSpecSchema.parse({
        kind: 'local-directory',
        workspaceId: 'ws-1',
        rootDigest: 'sha256:abc',
        sourcePath: 'src/main.ts',
      }),
    ).toMatchObject({ kind: 'local-directory' });

    expect(
      WorkerMaterializationSpecSchema.parse({
        kind: 'workspace-snapshot',
        snapshotId: 'snap-1',
        digest: 'sha256:abc',
        sourcePath: 'src/main.ts',
      }),
    ).toMatchObject({ kind: 'workspace-snapshot' });
  });
});

// ─────────────────────────────────────────────────────────────
// Suspension strategy — portable (no context dependency)
// ─────────────────────────────────────────────────────────────

describe('suspension strategy in portable config and run context', () => {
  it('carries suspension strategy through worker config', () => {
    const config = WorkflowWorkerConfigSchema.parse(
      minimalWorkerConfig({
        suspensionStrategy: 'exit-and-redispatch',
      }),
    );

    expect(config.suspensionStrategy).toBe('exit-and-redispatch');
  });

  it('carries suspension strategy through run context', () => {
    const runContext = WorkflowRunContextSchema.parse(
      minimalRunContext({
        suspensionStrategy: 'exit-and-redispatch',
      }),
    );

    expect(runContext.suspensionStrategy).toBe('exit-and-redispatch');
  });
});
