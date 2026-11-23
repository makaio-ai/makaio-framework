import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalLauncher, type LocalExecutionSite } from '@makaio/subprocess';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLocalCodeStep } from '../code-step-process.js';

let workspace: string;
let site: LocalExecutionSite;
const step = { kind: 'step', stepId: 'check', execution: 1 } as const;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'code-step-process-'));
  site = createLocalLauncher({
    workspaceRoot: workspace,
    stepHomeRoot: join(workspace, 'steps'),
    runtimeHomeRoot: join(workspace, 'runtime'),
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await site?.launcher.closeAll();
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
});

/**
 * Start a real Node process speaking the code step output protocol.
 * @param source - Program to run.
 * @param signal - Optional parent-side cancellation.
 * @param timeoutMs - Deadline used by this test invocation.
 * @returns The parent's result.
 */
function run(source: string, signal?: AbortSignal, timeoutMs = 10_000) {
  return runLocalCodeStep(site.launcher, {
    owner: step,
    command: process.execPath,
    args: ['-e', source],
    env: { STEP_ALLOWED: 'allowed' },
    timeoutMs,
    signal,
  });
}

const submit = `
  const { createInterface } = require('node:readline');
  const input = createInterface({ input: process.stdin });
  const lines = input[Symbol.asyncIterator]();
  async function submit(id, params) {
    console.log(JSON.stringify({ jsonrpc: '2.0', id, method: 'output.submit', params }));
    const { value } = await lines.next();
    return JSON.parse(value);
  }
  const finish = () => { input.close(); process.stdin.pause(); };
  const stepResult = (output) => ({ status: 'completed', output, telemetry: { duration: 0 } });
`;

describe.skipIf(process.platform === 'win32')('local code step output boundary', () => {
  it('runs delegated code in an isolated child and acknowledges its validated result', async () => {
    vi.stubEnv('STEP_HOST_ONLY', 'synthetic');
    const output = await run(`${submit}
      (async () => {
        const result = stepResult({
          pid: process.pid,
          home: process.env.HOME,
          allowed: process.env.STEP_ALLOWED,
          inherited: 'STEP_HOST_ONLY' in process.env,
        });
        const ack = await submit(1, result);
        if (ack.id !== 1 || ack.result?.accepted !== true) process.exitCode = 1;
        const retry = await submit(2, result);
        if (retry.id !== 2 || retry.result?.accepted !== true) process.exitCode = 1;
        finish();
      })();
    `);
    expect(output).toMatchObject({
      kind: 'reported',
      result: {
        status: 'completed',
        output: { home: site.paths(step).home, allowed: 'allowed', inherited: false },
      },
    });
    if (output.kind !== 'reported') return;
    expect(output.result.output).toHaveProperty('pid');
    expect(output.result.output).not.toHaveProperty('pid', process.pid);
  });

  it('rejects an accepted result when the execution site could not prove containment', async () => {
    const launcher = site.launcher;
    const result = runLocalCodeStep(
      {
        boundary: launcher.boundary,
        closeOwner: (owner) => launcher.closeOwner(owner),
        closeAll: () => launcher.closeAll(),
        launch: (options) => {
          const handle = launcher.launch(options);
          return {
            ...handle,
            result: handle.result.then((process) => ({
              ...process,
              containment: { kind: 'unproven', boundary: launcher.boundary, reason: 'termination-unconfirmed' },
            })),
          };
        },
      },
      {
        owner: step,
        command: process.execPath,
        args: ['-e', `${submit} submit(1, stepResult(null)).finally(finish);`],
        env: {},
        timeoutMs: 10_000,
      },
    );
    await expect(result).resolves.toMatchObject({ kind: 'process-failed', reason: 'process-exit' });
  });

  it('accepts a complete result even if the child has already closed its input', async () => {
    await expect(
      run(`
      const fs = require('node:fs');
      fs.closeSync(0);
      console.log(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'output.submit',
        params: { status: 'completed', output: null, telemetry: { duration: 0 } },
      }));
      setTimeout(() => {}, 100);
    `),
    ).resolves.toMatchObject({ kind: 'reported', result: { output: null } });
  });

  it('rejects stdout over the output budget', async () => {
    await expect(run("process.stdout.write('x'.repeat(2 * 1024 * 1024));")).resolves.toMatchObject({
      kind: 'process-failed',
      process: { status: 'output-limit' },
    });
  });

  it('discards an acknowledged result when the child fails to exit within the deadline', async () => {
    await expect(
      run(`${submit} submit(1, stepResult(null)).then(() => setInterval(() => {}, 1000));`, undefined, 1500),
    ).resolves.toMatchObject({ kind: 'timed-out' });
  });

  it('stops a child that keeps running after an invalid submission', async () => {
    const source = `${submit} submit(1, { status: 'completed' }).then(() => setInterval(() => {}, 1000));`;
    await expect(run(source, undefined, 10_000)).resolves.toMatchObject({
      kind: 'process-failed',
      reason: 'invalid-output',
    });
  });

  it('preserves request cancellation after partial output', async () => {
    const abort = new AbortController();
    const outcome = run(
      `
      process.stdout.write('{');
      require('node:fs').writeFileSync('partial-ready', 'yes');
      setInterval(() => {}, 1000);
    `,
      abort.signal,
    );
    await expect
      .poll(() => readFile(join(workspace, 'partial-ready'), 'utf8').catch(() => ''), { timeout: 4000 })
      .toBe('yes');
    abort.abort();
    await expect(outcome).resolves.toMatchObject({ kind: 'cancelled', process: { cancellationSource: 'request' } });
  }, 15_000);

  it('preserves the deadline outcome when a partial frame ends afterward', async () => {
    await expect(
      run("process.stdout.write('{'); setInterval(() => {}, 1000);", undefined, 1500),
    ).resolves.toMatchObject({ kind: 'timed-out' });
  });

  it('preserves owner cancellation after partial output', async () => {
    const outcome = run(`
      process.stdout.write('{');
      require('node:fs').writeFileSync('partial-ready', 'yes');
      setInterval(() => {}, 1000);
    `);
    await expect
      .poll(() => readFile(join(workspace, 'partial-ready'), 'utf8').catch(() => ''), { timeout: 4000 })
      .toBe('yes');
    await site.launcher.closeOwner(step);
    await expect(outcome).resolves.toMatchObject({ kind: 'cancelled', process: { cancellationSource: 'owner' } });
  }, 15_000);

  it('rejects a second result with different content', async () => {
    await expect(
      run(`${submit}
      (async () => {
        await submit(1, stepResult({ ok: true }));
        const reply = await submit(2, stepResult({ ok: false }));
        if (!reply.error) process.exitCode = 1;
        finish();
      })();
    `),
    ).resolves.toMatchObject({ kind: 'process-failed', reason: 'conflicting-output' });
  });

  it('rejects an uncorrelated output frame following an acknowledged result', async () => {
    await expect(
      run(`${submit}
      (async () => {
        await submit(1, stepResult(null));
        console.log(JSON.stringify({ jsonrpc: '2.0', method: 'output.submit', params: stepResult(false) }));
        finish();
      })();
    `),
    ).resolves.toMatchObject({ kind: 'process-failed', reason: 'invalid-output' });
  });

  it('projects a child-reported failure into a content-free diagnostic', async () => {
    const result = await run(`${submit}
      submit(1, { status: 'failed', error: 'synthetic-child-diagnostic', telemetry: { duration: 0 } })
        .finally(finish);
    `);
    expect(result).toMatchObject({
      kind: 'reported',
      result: { status: 'failed', error: 'Code step reported a failure' },
    });
  });

  it('rejects a retry that exceeds the JSON boundary nesting limit', async () => {
    await expect(
      run(`${submit}
      (async () => {
        await submit(1, stepResult(null));
        const nested = '['.repeat(12000) + 'null' + ']'.repeat(12000);
        console.log('{"jsonrpc":"2.0","id":2,"method":"output.submit","params":{"status":"completed","telemetry":{"duration":0},"output":' + nested + '}}');
        const { value } = await lines.next();
        if (!JSON.parse(value).error) process.exitCode = 1;
        finish();
      })();
    `),
    ).resolves.toMatchObject({ kind: 'process-failed', reason: 'invalid-output' });
  });

  it.each([
    ['no-output', ''],
    ['invalid-output', `${submit} submit(1, { status: 'completed', telemetry: { duration: 0 } }).finally(finish);`],
    [
      'invalid-output',
      `${submit} submit(1, stepResult('byte')).finally(finish);`.replace(
        "console.log(JSON.stringify({ jsonrpc: '2.0', id, method: 'output.submit', params }));",
        "process.stdout.write(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'output.submit', params }).replace('byte', '\u00ff') + '\\n', 'latin1'));",
      ),
    ],
    ['invalid-output', "console.log('{wrong');"],
    ['invalid-output', `${submit} submit(1, { status: 'completed' }).finally(finish);`],
  ])('rejects a child without a valid handoff (%s)', async (reason, source) => {
    await expect(run(source)).resolves.toMatchObject({ kind: 'process-failed', reason });
  });

  it.skipIf(process.platform === 'win32')('settles cancellation with the observed process-group evidence', async () => {
    const abort = new AbortController();
    const outcome = run(
      "require('node:fs').writeFileSync('ready', 'running'); setInterval(() => {}, 1000);",
      abort.signal,
    );
    await expect
      .poll(() => readFile(join(workspace, 'ready'), 'utf8').catch(() => ''), { timeout: 4000 })
      .toBe('running');
    abort.abort();
    await expect(outcome).resolves.toMatchObject({
      kind: 'cancelled',
      process: { status: 'cancelled', containment: { kind: 'quiescent', boundary: 'process-group' } },
    });
  });
});
