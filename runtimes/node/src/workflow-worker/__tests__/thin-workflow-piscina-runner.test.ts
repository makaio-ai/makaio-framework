import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowWorkerConfig } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import type { ThinWorkflowPiscinaRunnerOptions } from '../types.js';

// Mock PiscinaPoolRunner before importing the class under test.
const mockPoolRun = vi.fn();
const mockMaterializeLocalDirectory = vi.fn();

vi.mock('../runtime/piscina-pool-runner.js', () => ({
  PiscinaPoolRunner: class MockPiscinaPoolRunner {
    public constructor(_options: ThinWorkflowPiscinaRunnerOptions) {}

    public run = mockPoolRun;
    public dispose = vi.fn();
  },
}));

vi.mock('../local-directory-materializer.js', () => ({
  materializeLocalDirectory: mockMaterializeLocalDirectory,
}));

// Import after mocking
const { ThinWorkflowPiscinaRunner } = await import('../thin-workflow-piscina-runner.js');

/**
 * Create a minimal WorkflowWorkerConfig for testing.
 * @param overrides - Optional config fields to replace in the fixture.
 * @returns A valid WorkflowWorkerConfig stub.
 */
function makeConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'test-workflow' },
    executionId: 'test-exec',
    workflowId: 'test-workflow',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    env: {},
    coordinatorSessionId: 'test-session',
    cancelSubject: 'workflow.cancel.test',
    ...overrides,
  };
}

/**
 * Create default runner options for testing.
 * @returns ThinWorkflowPiscinaRunnerOptions with test values.
 */
function makeOptions(): ThinWorkflowPiscinaRunnerOptions {
  return {
    workerEntry: '/path/to/workflow-worker-entry.mjs',
    manifest: { contributionRefs: [] },
  };
}

describe('ThinWorkflowPiscinaRunner', () => {
  beforeEach(() => {
    mockPoolRun.mockReset();
    mockMaterializeLocalDirectory.mockReset();
  });

  it('passes config and construction-time manifest to pool.run()', async () => {
    const expectedResult = {
      executionId: 'test-exec',
      workflowId: 'test-workflow',
      status: 'completed',
    };
    mockPoolRun.mockResolvedValueOnce(expectedResult);

    const options = makeOptions();
    const runner = new ThinWorkflowPiscinaRunner(options);
    const config = makeConfig();
    const signal = new AbortController().signal;

    const result = await runner.run(createTestCall(), config, signal);

    expect(mockPoolRun).toHaveBeenCalledOnce();
    expect(mockPoolRun).toHaveBeenCalledWith(
      { kind: 'unbound', config, manifest: options.manifest, contributionEntrypoints: [] },
      signal,
    );
    expect(result).toEqual({ state: 'uncommitted', result: expectedResult });
  });

  it('materializes a local-directory source and verified contributions before dispatching to Piscina', async () => {
    const expectedResult = {
      executionId: 'test-exec',
      workflowId: 'test-workflow',
      status: 'completed' as const,
    };
    const manifest = {
      contributionRefs: [
        {
          packageName: 'pkg-a',
          version: '1.0.0',
          entrypoint: 'dist/worker.mjs',
          integrity: 'sha384-verified',
        },
      ],
    };
    const config = makeConfig({
      source: { kind: 'path', path: 'workflows/example.mjs' },
      materializationSpec: {
        kind: 'local-directory',
        workspaceId: 'workspace-a',
        rootDigest: 'sha256-workspace',
        sourcePath: 'workflows/example.mjs',
      },
    });
    const resolveWorkspaceRoot = vi.fn().mockResolvedValue('/workspace-a');
    mockMaterializeLocalDirectory.mockResolvedValueOnce({
      workspaceRoot: '/workspace-a',
      sourcePath: '/workspace-a/workflows/example.mjs',
      contributionEntrypoints: ['/workspace-a/node_modules/pkg-a/dist/worker.mjs'],
      platform: 'linux',
      arch: 'x64',
    });
    mockPoolRun.mockResolvedValueOnce(expectedResult);

    const runner = new ThinWorkflowPiscinaRunner({ ...makeOptions(), resolveWorkspaceRoot });
    await runner.run(createTestCall(), config, new AbortController().signal, manifest);

    expect(mockMaterializeLocalDirectory).toHaveBeenCalledWith(config.materializationSpec, manifest.contributionRefs, {
      resolveWorkspaceRoot,
    });
    expect(mockPoolRun).toHaveBeenCalledWith(
      {
        kind: 'unbound',
        config: {
          ...config,
          source: { kind: 'path', path: '/workspace-a/workflows/example.mjs' },
        },
        workspaceRoot: '/workspace-a',
        manifest,
        contributionEntrypoints: ['/workspace-a/node_modules/pkg-a/dist/worker.mjs'],
      },
      expect.any(AbortSignal),
    );
  });

  it('requires a local-directory realization for declared contributions', async () => {
    const expectedResult = {
      executionId: 'test-exec',
      workflowId: 'test-workflow',
      status: 'completed',
    };
    mockPoolRun.mockResolvedValueOnce(expectedResult);

    const runner = new ThinWorkflowPiscinaRunner(makeOptions());
    const config = makeConfig();
    const signal = new AbortController().signal;
    const perCallManifest = {
      contributionRefs: [
        {
          packageName: 'pkg-a',
          version: '1.0.0',
          entrypoint: 'pkg-a.js',
          integrity: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uFPNZHzA3w0=',
        },
      ],
    };

    await expect(runner.run(createTestCall(), config, signal, perCallManifest)).rejects.toThrow(
      'requires a local-directory materialization spec',
    );
    expect(mockPoolRun).not.toHaveBeenCalled();
  });

  it('propagates abort signal to pool.run()', async () => {
    const controller = new AbortController();
    mockPoolRun.mockRejectedValueOnce(new Error('The task was aborted'));

    const runner = new ThinWorkflowPiscinaRunner(makeOptions());
    controller.abort();

    await expect(runner.run(createTestCall(), makeConfig(), controller.signal)).rejects.toThrow('aborted');
    expect(mockPoolRun).not.toHaveBeenCalled();
  });

  it('propagates pool.run() rejection to caller', async () => {
    const error = new Error('Worker thread crashed');
    mockPoolRun.mockRejectedValueOnce(error);

    const runner = new ThinWorkflowPiscinaRunner(makeOptions());

    await expect(runner.run(createTestCall(), makeConfig(), new AbortController().signal)).rejects.toThrow(
      'Worker thread crashed',
    );
  });
});
