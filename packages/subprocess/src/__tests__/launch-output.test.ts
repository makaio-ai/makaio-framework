import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launch, type LaunchOptions, type LaunchResult } from '../launch.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

/**
 * Create a temporary directory that is removed after the test.
 * @returns Its real path.
 */
async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'launch-output-')));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * Launch an inline Node program with short bounds and wait for its result.
 * @param source - Inline Node program.
 * @param overrides - Options that replace the defaults of the helper.
 * @param args - Arguments after the program.
 * @returns The settled result.
 */
function runNode(
  source: string,
  overrides: Partial<LaunchOptions> = {},
  args: readonly string[] = [],
): Promise<LaunchResult> {
  return launch({
    command: process.execPath,
    args: ['-e', source, ...args],
    cwd: os.tmpdir(),
    envMode: 'merge',
    timeoutMs: 20_000,
    killGraceMs: 200,
    exitObservationMs: 1_000,
    output: { kind: 'capture', limitBytes: 100_000 },
    ...overrides,
  }).result;
}

describePosix('launch output', () => {
  it('captures stdout and stderr separately', async () => {
    const result = await runNode('process.stdout.write("out-text"); process.stderr.write("err-text");');
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ stdout: 'out-text', stderr: 'err-text' });
  });

  it('decodes a multi-byte character that is split across chunks', async () => {
    const result = await runNode(
      `process.stdout.write(Buffer.from([0xe2, 0x82]));
       setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x21])), 100);`,
    );
    expect(result.status).toBe('completed');
    expect(result.output?.stdout).toBe('€!');
  });

  it('stops a command that exceeds the limit and truncates the output at the limit', async () => {
    const result = await runNode('process.stdout.write("x".repeat(1000)); setInterval(() => undefined, 1000);', {
      output: { kind: 'capture', limitBytes: 10 },
    });
    expect(result.status).toBe('output-limit');
    expect(result.output).toEqual({ stdout: 'x'.repeat(10), stderr: '' });
    expect(result.group?.tree.kind).toBe('quiescent');
    expect(result.group?.signalDelivered).toBe(true);
  });

  it('lets a silent command complete with empty output under a limit of 0', async () => {
    const result = await runNode('process.exit(0);', { output: { kind: 'capture', limitBytes: 0 } });
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ stdout: '', stderr: '' });
  });

  it('ends a noisy command as output-limit with empty output under a limit of 0', async () => {
    const result = await runNode('process.stdout.write("noise"); setInterval(() => undefined, 1000);', {
      output: { kind: 'capture', limitBytes: 0 },
    });
    expect(result.status).toBe('output-limit');
    expect(result.output).toEqual({ stdout: '', stderr: '' });
  });

  it('reports no output field for ignore', async () => {
    const result = await runNode('process.stdout.write("discarded");', { output: { kind: 'ignore' } });
    expect(result.status).toBe('completed');
    expect(result).not.toHaveProperty('output');
  });
});

describePosix('launch environment and arguments', () => {
  const printEnv = 'process.stdout.write(JSON.stringify(process.env));';

  it('replace gives the child only the given entries', async () => {
    vi.stubEnv('LAUNCH_TEST_HOST_VARIABLE', 'host-value');
    const result = await runNode(printEnv, { envMode: 'replace', env: { LAUNCH_TEST_GIVEN: 'given' } });
    expect(result.status).toBe('completed');
    const seen: Record<string, string | undefined> = JSON.parse(result.output?.stdout ?? '{}');
    expect(seen.LAUNCH_TEST_GIVEN).toBe('given');
    expect(seen.LAUNCH_TEST_HOST_VARIABLE).toBeUndefined();
    expect(seen.PATH).toBeUndefined();
  });

  it('merge shows host variables and lets undefined remove an inherited one', async () => {
    vi.stubEnv('LAUNCH_TEST_KEPT', 'kept');
    vi.stubEnv('LAUNCH_TEST_REMOVED', 'removed');
    const result = await runNode(printEnv, {
      envMode: 'merge',
      env: { LAUNCH_TEST_REMOVED: undefined, LAUNCH_TEST_ADDED: 'added' },
    });
    expect(result.status).toBe('completed');
    const seen: Record<string, string | undefined> = JSON.parse(result.output?.stdout ?? '{}');
    expect(seen.LAUNCH_TEST_KEPT).toBe('kept');
    expect(seen.LAUNCH_TEST_ADDED).toBe('added');
    expect(seen).not.toHaveProperty('LAUNCH_TEST_REMOVED');
  });

  it('honours cwd', async () => {
    const directory = await makeTemporaryDirectory();
    const result = await runNode('process.stdout.write(process.cwd());', { cwd: directory });
    expect(result.status).toBe('completed');
    expect(result.output?.stdout).toBe(directory);
  });

  it('passes arguments without shell parsing', async () => {
    const result = await runNode('process.stdout.write(JSON.stringify(process.argv.slice(1)));', {}, [
      'a;b',
      '$HOME',
      'x y',
    ]);
    expect(result.status).toBe('completed');
    expect(JSON.parse(result.output?.stdout ?? '[]')).toEqual(['a;b', '$HOME', 'x y']);
  });
});
