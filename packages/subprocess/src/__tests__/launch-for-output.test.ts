import { describe, expect, it } from 'vitest';
import { launchForOutput, type LaunchForOutputOptions } from '../launch-for-output.js';
import { recordingLaunch } from '../testing/index.js';

/**
 * Options for one real node command.
 * @param script - Source the command runs.
 * @param extra - Further options of the call.
 * @returns The options.
 */
function command(
  script: string,
  extra: { readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly outputLimitBytes?: number } = {},
): LaunchForOutputOptions {
  return {
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    envMode: 'merge',
    timeoutMs: 10_000,
    outputLimitBytes: 1024,
    ...extra,
  };
}

describe('launchForOutput', () => {
  it('returns stdout and stderr of a completed command', async () => {
    const outcome = await launchForOutput(command('process.stdout.write("out");process.stderr.write("err")'));
    expect(outcome).toEqual({ ok: true, stdout: 'out', stderr: 'err' });
  });

  it('returns the result of a command that failed', async () => {
    const outcome = await launchForOutput(command('process.exit(3)'));
    expect(outcome).toMatchObject({ ok: false, result: { status: 'failed' } });
  });

  it('returns the result of a refused command', async () => {
    const outcome = await launchForOutput(command('', { timeoutMs: 0 }));
    expect(outcome).toMatchObject({ ok: false, result: { status: 'spawn-failed', refusal: 'invalid-timeout' } });
  });

  it('returns the refusal of an invalid output limit', async () => {
    const outcome = await launchForOutput(command('', { outputLimitBytes: NaN }));
    expect(outcome).toMatchObject({ ok: false, result: { status: 'spawn-failed', refusal: 'invalid-output-limit' } });
  });

  it('returns the result of a command that exceeded the output limit', async () => {
    const outcome = await launchForOutput(command('process.stdout.write("x".repeat(5000))', { outputLimitBytes: 10 }));
    expect(outcome).toMatchObject({ ok: false, result: { status: 'output-limit' } });
  });

  it('rethrows the abort reason when the signal cancelled the command', async () => {
    const controller = new AbortController();
    const reason = new Error('stop it');
    const running = launchForOutput(command('setInterval(()=>{},100)', { signal: controller.signal }));
    setTimeout(() => controller.abort(reason), 100);
    await expect(running).rejects.toBe(reason);
  });

  it('rethrows the abort reason of a signal that was aborted before the start', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already'));
    await expect(launchForOutput(command('', { signal: controller.signal }))).rejects.toBe(controller.signal.reason);
  });

  it('runs the given start port with the capture limit', async () => {
    const recorded = recordingLaunch({ status: 'completed', output: { stdout: 'a', stderr: '' } });
    const outcome = await launchForOutput(command('', { outputLimitBytes: 64 }), recorded.launch);
    expect(outcome).toEqual({ ok: true, stdout: 'a', stderr: '' });
    expect(recorded.calls[0]?.output).toEqual({ kind: 'capture', limitBytes: 64 });
  });

  it('gets empty captured output from a recording port that was given no result', async () => {
    const recorded = recordingLaunch();
    const outcome = await launchForOutput(command(''), recorded.launch);
    expect(outcome).toEqual({ ok: true, stdout: '', stderr: '' });
  });
});
