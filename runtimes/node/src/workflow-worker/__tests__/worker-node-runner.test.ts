import { describe, expect, it, vi } from 'vitest';
import type { WorkerContributionManifest } from '@makaio/contracts';
import { WorkerNodeRunner } from '../worker-node-runner.js';
import { makeWorkerConfig } from './fixtures.js';

describe('WorkerNodeRunner', () => {
  it('delegates workflow execution through the injected dispatch seam', async () => {
    const manifest: WorkerContributionManifest = { packages: [] };
    const dispatch = vi.fn().mockResolvedValue({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'completed',
    });
    const runner = new WorkerNodeRunner({ dispatch, manifest });
    const signal = new AbortController().signal;

    const result = await runner.run(makeWorkerConfig(), signal);

    expect(dispatch).toHaveBeenCalledWith({ config: makeWorkerConfig(), manifest }, signal);
    expect(result.status).toBe('completed');
  });

  it('forwards optional requirements to the dispatch function', async () => {
    const manifest: WorkerContributionManifest = { packages: [] };
    const requirements = { persistentStorage: true, customCapabilities: [] };
    const dispatch = vi.fn().mockResolvedValue({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'completed',
    });
    const runner = new WorkerNodeRunner({ dispatch, manifest, requirements });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal);

    expect(dispatch).toHaveBeenCalledWith({ config: makeWorkerConfig(), manifest, requirements }, signal);
  });

  it('omits requirements from the dispatch payload when not provided', async () => {
    const manifest: WorkerContributionManifest = { packages: [] };
    const dispatch = vi.fn().mockResolvedValue({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'completed',
    });
    const runner = new WorkerNodeRunner({ dispatch, manifest });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal);

    const [callArg] = dispatch.mock.calls[0]!;
    expect('requirements' in callArg).toBe(false);
  });

  it('omits manifest from the dispatch payload when no manifest source is provided', async () => {
    const dispatch = vi.fn().mockResolvedValue({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'completed',
    });
    const runner = new WorkerNodeRunner({ dispatch });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal);

    const [callArg] = dispatch.mock.calls[0]!;
    expect('manifest' in callArg).toBe(false);
  });

  it('forwards a per-call manifest when no construction-time manifest is provided', async () => {
    const perCallManifest: WorkerContributionManifest = {
      packages: [{ name: '@acme/tools', importPath: '@acme/tools/server' }],
    };
    const dispatch = vi.fn().mockResolvedValue({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'completed',
    });
    const runner = new WorkerNodeRunner({ dispatch });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal, perCallManifest);

    expect(dispatch).toHaveBeenCalledWith({ config: makeWorkerConfig(), manifest: perCallManifest }, signal);
  });

  it('uses a per-call manifest in preference to the construction-time manifest', async () => {
    const constructionManifest: WorkerContributionManifest = { packages: [] };
    const perCallManifest: WorkerContributionManifest = {
      packages: [{ name: '@acme/tools', importPath: '@acme/tools/server' }],
    };
    const dispatch = vi.fn().mockResolvedValue({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'completed',
    });
    const runner = new WorkerNodeRunner({ dispatch, manifest: constructionManifest });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal, perCallManifest);

    expect(dispatch).toHaveBeenCalledWith({ config: makeWorkerConfig(), manifest: perCallManifest }, signal);
  });

  it('falls back to the construction-time manifest when no per-call manifest is provided', async () => {
    const constructionManifest: WorkerContributionManifest = {
      packages: [{ name: '@acme/tools', importPath: '@acme/tools/server' }],
    };
    const dispatch = vi.fn().mockResolvedValue({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'completed',
    });
    const runner = new WorkerNodeRunner({ dispatch, manifest: constructionManifest });
    const signal = new AbortController().signal;

    await runner.run(makeWorkerConfig(), signal);

    expect(dispatch).toHaveBeenCalledWith({ config: makeWorkerConfig(), manifest: constructionManifest }, signal);
  });

  it('propagates dispatch rejection to caller', async () => {
    const manifest: WorkerContributionManifest = { packages: [] };
    const dispatch = vi.fn().mockRejectedValue(new Error('Dispatch failed'));
    const runner = new WorkerNodeRunner({ dispatch, manifest });

    await expect(runner.run(makeWorkerConfig(), new AbortController().signal)).rejects.toThrow('Dispatch failed');
  });
});
