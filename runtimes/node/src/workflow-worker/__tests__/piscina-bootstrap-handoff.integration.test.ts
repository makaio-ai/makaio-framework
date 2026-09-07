import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThinWorkflowPiscinaRunner } from '../thin-workflow-piscina-runner.js';
import { PiscinaPoolRunner } from '../runtime/piscina-pool-runner.js';
import { dispatchWithBootstrapHandoff } from '../piscina-bootstrap-handoff.js';
import { makeWorkerConfig } from './fixtures.js';

const workerEntry = fileURLToPath(new URL('./fixtures/piscina-bootstrap-worker.mjs', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

/**
 * Allocate a real one-thread runner and task-controlled occupancy files.
 * @returns Runner, scratch directory and config builder.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'piscina-handoff-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runner = new ThinWorkflowPiscinaRunner({ workerEntry, manifest: { contributionRefs: [] }, maxConcurrency: 1 });
  cleanups.push(() => runner.dispose());
  return { root, runner };
}

describe('real Piscina bootstrap budget ownership', () => {
  it('expires a queued attempt without starting it or aborting the unrelated occupying task', async () => {
    const { root, runner } = await fixture();
    const occupying = runner.run(
      makeWorkerConfig({
        inputs: { started: join(root, 'occupying'), release: join(root, 'release') },
      }),
      new AbortController().signal,
    );
    void occupying.catch(() => undefined);
    await vi.waitFor(() => expect(existsSync(join(root, 'occupying'))).toBe(true), { timeout: 10_000 });
    const pending = runner.runWithReadiness(
      makeWorkerConfig({ inputs: { started: join(root, 'queued') } }),
      new AbortController().signal,
      undefined,
      {
        executionAttemptId: 'queued-attempt',
        bootstrapDeadlineAt: new Date(Date.now() + 100).toISOString(),
      },
    );
    const settlements = await Promise.allSettled([pending.result, pending.ready]);
    expect(settlements).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'WORKER_BOOTSTRAP_DEADLINE_EXCEEDED' }) },
      { status: 'rejected', reason: expect.objectContaining({ code: 'WORKER_BOOTSTRAP_DEADLINE_EXCEEDED' }) },
    ]);
    await writeFile(join(root, 'release'), 'release');
    await expect(occupying).resolves.toMatchObject({ result: { status: 'completed' } });
    await expect(runner.run(makeWorkerConfig(), new AbortController().signal)).resolves.toMatchObject({
      result: { status: 'completed' },
    });
    expect(existsSync(join(root, 'queued'))).toBe(false);
  }, 15_000);

  it('cancels a task while its actual worker module is still loading', async () => {
    const pool = new PiscinaPoolRunner<unknown, unknown>({
      workerEntry: fileURLToPath(new URL('./fixtures/piscina-cold-bootstrap-worker.mjs', import.meta.url)),
      maxConcurrency: 1,
    });
    cleanups.push(() => pool.dispose());
    const loading = Promise.withResolvers<void>();
    const off = pool.onMessage((message) => {
      if (message === 'cold-module-loading') loading.resolve();
    });
    try {
      await loading.promise;
      const deadlineAt = new Date(Date.now() + 100).toISOString();
      await expect(
        dispatchWithBootstrapHandoff(deadlineAt, new AbortController().signal, (bootstrapPort, signal) =>
          pool.run(
            { kind: 'attempt-bound', bootstrapPort, bootstrapDeadlineAt: deadlineAt, config: makeWorkerConfig() },
            signal,
            [bootstrapPort],
          ),
        ),
      ).rejects.toMatchObject({ code: 'WORKER_BOOTSTRAP_DEADLINE_EXCEEDED' });
    } finally {
      off();
    }
  });

  it.each([false, true])('keeps invocation alive beyond handoff deadline; caller cancellation = %s', async (cancel) => {
    const { root, runner } = await fixture();
    // Warm the same worker first; the short budget below measures handoff, not
    // dependency compilation on the test host.
    await runner.run(makeWorkerConfig(), new AbortController().signal);
    const controller = new AbortController();
    const deadlineAt = new Date(Date.now() + 1000).toISOString();
    const pending = runner.runWithReadiness(
      makeWorkerConfig({ inputs: { release: join(root, 'release') } }),
      controller.signal,
      undefined,
      { executionAttemptId: 'running-attempt', bootstrapDeadlineAt: deadlineAt },
    );
    void pending.result.catch(() => undefined);
    await expect(pending.ready).resolves.toMatchObject({ executionAttemptId: 'running-attempt' });
    await delay(Math.max(0, Date.parse(deadlineAt) - Date.now()) + 10);
    if (cancel) {
      controller.abort(new Error('caller cancellation after handoff'));
      await expect(pending.result).rejects.toThrow('aborted');
    } else {
      await writeFile(join(root, 'release'), 'release');
      await expect(pending.result).resolves.toMatchObject({ status: 'completed' });
    }
  }, 15_000);
});
