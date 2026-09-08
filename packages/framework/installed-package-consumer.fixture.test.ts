import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInstalledPackageSetupStage } from './installed-package-consumer.fixture.js';

const execFileAsync = promisify(execFile);
const childOutput = [
  '[build] bus — 7 entries',
  '[build] bus done in 1.2s',
  '[build] core — 123 entries',
  'untrusted-output-sentinel',
  '[build] arbitrary — 1 entries',
  '[build] core done in 2.0s untrusted-output-sentinel',
  '[build] react — untrusted-output-sentinel entries',
].join('\n');

afterEach(() => vi.restoreAllMocks());

describe('installed package setup diagnostics', () => {
  it('preserves a successful real child result and reports only fixed build progress and timing', async () => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const result = await runInstalledPackageSetupStage('build', () =>
      execFileAsync(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(childOutput)})`]),
    );
    expect(result.stdout).toBe(childOutput);
    const diagnostic = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(diagnostic).toMatch(/started at [0-9]+ms; parallelism [0-9]+/);
    expect(diagnostic).toMatch(/completed at [0-9]+ms after [0-9]+ms; started at [0-9]+ms/);
    expect(diagnostic).toContain('[build] bus — 7 entries');
    expect(diagnostic).toContain('[build] bus done in 1.2s');
    expect(diagnostic).toContain('[build] core — 123 entries');
    expect(diagnostic).not.toContain('untrusted-output-sentinel');
    expect(diagnostic).not.toContain('arbitrary');
  });

  it('retains allowlisted partial progress when a real child is aborted', async () => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const controller = new AbortController();
    const execution = runInstalledPackageSetupStage('build', () => {
      const child = execFileAsync(
        process.execPath,
        ['-e', `process.stdout.write(${JSON.stringify(childOutput)}); setInterval(() => {}, 1000);`],
        { signal: controller.signal, timeout: 3000 },
      );
      // Abort only after the real child has produced its partial build progress.
      child.child.stdout?.once('data', () => controller.abort());
      return child;
    });
    const error = await execution.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    const diagnostic = String(error);
    expect(diagnostic).toMatch(/stage "build" aborted after [0-9]+ms/);
    expect(diagnostic).toMatch(/started at [0-9]+ms; ended at [0-9]+ms; parallelism [0-9]+/);
    expect(diagnostic).toContain('[build] bus done in 1.2s');
    expect(diagnostic).toContain('[build] core — 123 entries');
    expect(diagnostic).not.toContain('untrusted-output-sentinel');
    expect(diagnostic).not.toContain('arbitrary');
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join('')).not.toContain('untrusted-output-sentinel');
  });

  it('does not forward child messages or build-shaped output from a non-build failure', async () => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(
      runInstalledPackageSetupStage('install', () =>
        execFileAsync(process.execPath, [
          '-e',
          `process.stdout.write(${JSON.stringify(childOutput)}); throw Error('untrusted-error-sentinel');`,
        ]),
      ),
    ).rejects.toThrow(/stage "install" child process failed after [0-9]+ms/);
    const diagnostic = output.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(diagnostic).not.toContain('[build]');
    expect(diagnostic).not.toContain('untrusted-');
  });
});
