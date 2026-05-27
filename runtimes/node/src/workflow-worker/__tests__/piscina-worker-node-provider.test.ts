import { describe, expect, it, vi } from 'vitest';
import type { WorkerContributionManifest, WorkflowRunResult, WorkflowWorkerConfig } from '@makaio/contracts';
import { PiscinaWorkerNodeProvider } from '../piscina-worker-node-provider.js';
import { makeWorkerConfig } from './fixtures.js';

describe('PiscinaWorkerNodeProvider', () => {
  it('returns a handle that waits on the underlying workflow runner', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ executionId: 'wfx-1', workflowId: 'workflow-1', status: 'completed' }),
      dispose: vi.fn(),
    };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-default', displayName: 'Piscina', runner });

    const handle = await provider.provision({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      workerConfig: makeWorkerConfig(),
      workerManifest: { packages: [] },
    });

    await expect(handle.waitForResult(new AbortController().signal)).resolves.toMatchObject({ status: 'completed' });
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it('exposes the correct environment constant', () => {
    const runner = { run: vi.fn() };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-1', displayName: 'Piscina', runner });

    expect(provider.environment).toBe('piscina');
  });

  it('uses default base capabilities when none provided', () => {
    const runner = { run: vi.fn() };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-1', displayName: 'Piscina', runner });

    expect(provider.baseCapabilities.persistentStorage).toBe(true);
    expect(provider.baseCapabilities.customCapabilities).toContain('workflow.local-runtime');
  });

  it('uses custom base capabilities when provided', () => {
    const runner = { run: vi.fn() };
    const customCapabilities = { persistentStorage: false, customCapabilities: ['custom.tag'] };
    const provider = new PiscinaWorkerNodeProvider({
      id: 'piscina-1',
      displayName: 'Piscina',
      runner,
      baseCapabilities: customCapabilities,
    });

    expect(provider.baseCapabilities.persistentStorage).toBe(false);
    expect(provider.baseCapabilities.customCapabilities).toEqual(['custom.tag']);
  });

  it('aborts the underlying runner when cancel is called', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')));
        });
      }),
    };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-1', displayName: 'Piscina', runner });

    const handle = await provider.provision({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      workerConfig: makeWorkerConfig(),
      workerManifest: { packages: [] },
    });

    await handle.cancel('test cancel');

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('aborts the underlying runner when terminate is called', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('terminated')));
        });
      }),
    };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-1', displayName: 'Piscina', runner });

    const handle = await provider.provision({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      workerConfig: makeWorkerConfig(),
      workerManifest: { packages: [] },
    });

    await handle.terminate();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it('forwards the request workerManifest to the runner as a per-call manifest', async () => {
    let capturedManifest: WorkerContributionManifest | undefined;
    const runner = {
      run: vi
        .fn()
        .mockImplementation(
          (_config: WorkflowWorkerConfig, _signal: AbortSignal, manifest?: WorkerContributionManifest) => {
            capturedManifest = manifest;
            return Promise.resolve({ executionId: 'wfx-1', workflowId: 'workflow-1', status: 'completed' });
          },
        ),
    };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-1', displayName: 'Piscina', runner });
    const requestManifest: WorkerContributionManifest = { packages: [{ name: 'pkg-a', importPath: './pkg-a.js' }] };

    const handle = await provider.provision({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      workerConfig: makeWorkerConfig(),
      workerManifest: requestManifest,
    });

    await handle.waitForResult(new AbortController().signal);

    expect(capturedManifest).toStrictEqual(requestManifest);
  });

  it('exposes runner readiness when the runner supports it', async () => {
    // This provider unit test pins the handoff contract: readiness-aware
    // runners must surface their ready promise on the WorkerNode handle. The
    // real Piscina runner/worker readiness path is covered in
    // workflow-piscina-runner and worker-entry integration tests.
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const result: Promise<WorkflowRunResult> = Promise.resolve({
      executionId: 'wfx-1',
      workflowId: 'workflow-1',
      status: 'completed',
    });
    const runner = {
      run: vi.fn(),
      runWithReadiness: vi.fn().mockReturnValue({ result, ready: ready.then(() => ({ adapters: ['adapter-a'] })) }),
    };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-1', displayName: 'Piscina', runner });

    const handle = await provider.provision({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      workerConfig: makeWorkerConfig(),
      workerManifest: { packages: [] },
    });

    expect(runner.runWithReadiness).toHaveBeenCalledOnce();
    expect(runner.run).not.toHaveBeenCalled();
    resolveReady();
    await expect(handle.ready).resolves.toEqual({ adapters: ['adapter-a'] });
  });

  it('cancel resolves after dispatching abort without waiting for runner settlement', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      }),
    };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-1', displayName: 'Piscina', runner });

    const handle = await provider.provision({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      workerConfig: makeWorkerConfig(),
      workerManifest: { packages: [] },
    });

    const cancelResult = Promise.race([
      handle.cancel('test').then(() => 'cancelled'),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 0)),
    ]);

    await expect(cancelResult).resolves.toBe('cancelled');
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBe('test');
  });

  it('waitForResult rejects promptly when called with an already-aborted signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      }),
    };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-1', displayName: 'Piscina', runner });

    const handle = await provider.provision({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      workerConfig: makeWorkerConfig(),
      workerManifest: { packages: [] },
    });

    const outerController = new AbortController();
    const abortReason = new Error('outer abort');
    outerController.abort(abortReason);
    const waitResult = Promise.race([
      handle.waitForResult(outerController.signal).then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 0)),
    ]);

    await expect(waitResult).resolves.toBe(abortReason);
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBe(abortReason);
  });

  it('abort listener on waitForResult signal is removed after the runner resolves', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, signal: AbortSignal) => {
        capturedSignal = signal;
        return Promise.resolve({ executionId: 'wfx-1', workflowId: 'workflow-1', status: 'completed' });
      }),
    };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-1', displayName: 'Piscina', runner });

    const handle = await provider.provision({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      workerConfig: makeWorkerConfig(),
      workerManifest: { packages: [] },
    });

    const outerController = new AbortController();
    const addEventListenerSpy = vi.spyOn(outerController.signal, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(outerController.signal, 'removeEventListener');

    await handle.waitForResult(outerController.signal);

    expect(addEventListenerSpy).toHaveBeenCalledOnce();
    expect(removeEventListenerSpy).toHaveBeenCalledOnce();
    const [eventName, listener, options] = addEventListenerSpy.mock.calls[0] ?? [];
    expect(eventName).toBe('abort');
    expect(options).toStrictEqual({ once: true });
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', listener);

    expect(() => outerController.abort('late abort')).not.toThrow();
    expect(capturedSignal?.aborted).toBe(false);
  });

  it('waitForResult rejects promptly when its signal aborts before runner settlement', async () => {
    let capturedSignal: AbortSignal | undefined;
    const runner = {
      run: vi.fn().mockImplementation((_config: WorkflowWorkerConfig, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise<never>(() => {});
      }),
    };
    const provider = new PiscinaWorkerNodeProvider({ id: 'piscina-1', displayName: 'Piscina', runner });

    const handle = await provider.provision({
      nodeId: 'node-1',
      executionId: 'wfx-1',
      environment: 'piscina',
      workerConfig: makeWorkerConfig(),
      workerManifest: { packages: [] },
    });

    const outerController = new AbortController();
    const waitPromise = handle.waitForResult(outerController.signal);
    const waitResult = Promise.race([
      waitPromise.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 0)),
    ]);
    const abortReason = new Error('outer abort');
    outerController.abort(abortReason);

    await expect(waitResult).resolves.toBe(abortReason);
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBe(abortReason);
  });
});
