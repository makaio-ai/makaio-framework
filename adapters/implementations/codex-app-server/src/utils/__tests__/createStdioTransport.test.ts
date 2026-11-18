/**
 * Which child the Codex transport factory starts, and how.
 *
 * The spawn boundary records the production inputs and then starts a harmless
 * real child in place of `codex`, so the shared transport's spawn path runs
 * unchanged without running a real codex binary. Framing, the end report and the
 * stop are driven through real app-server children in
 * `createStdioTransport.exit.test.ts`.
 */
import type { SpawnOptions } from 'node:child_process';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IJsonlTransport } from '@makaio/subprocess';
import { createStdioTransport } from '../createStdioTransport.js';

/** One recorded spawn call. */
interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

const spawnCalls = vi.hoisted(() => [] as SpawnCall[]);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
      spawnCalls.push({ command, args, options });
      return actual.spawn(process.execPath, ['-e', ''], options);
    }),
  };
});

const transports: IJsonlTransport[] = [];

/**
 * Create a transport and keep it for cleanup.
 * @param env - Environment handed to the factory.
 * @param binaryPath - Binary handed to the factory.
 * @returns The created transport.
 */
function create(env: Record<string, string | undefined>, binaryPath?: string): IJsonlTransport {
  const transport = createStdioTransport({ cwd: tmpdir(), env, binaryPath });
  transports.push(transport);
  return transport;
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  spawnCalls.splice(0);
});

describe('createStdioTransport', () => {
  it('spawns `codex app-server` as a direct child with exactly the given environment', () => {
    create({ PATH: '/usr/bin', HOME: undefined });

    expect(spawnCalls).toHaveLength(1);
    const [call] = spawnCalls;
    expect(call?.command).toBe('codex');
    expect(call?.args).toEqual(['app-server']);
    expect(call?.options).toMatchObject({ cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], detached: false });
    // Replaced, never merged: nothing of the host environment reaches the child,
    // and an undefined value is dropped instead of passed as a string.
    expect(call?.options.env).toEqual({ PATH: '/usr/bin' });
  });

  it('spawns the resolved binary when binaryPath is provided', () => {
    create({}, '/usr/local/bin/codex-managed');

    expect(spawnCalls[0]?.command).toBe('/usr/local/bin/codex-managed');
  });

  it.each([
    ['an empty', '   '],
    ['a relative', 'bin/codex'],
  ])('rejects %s binaryPath before spawning', (_label, binaryPath) => {
    expect(() => create({}, binaryPath)).toThrow('binaryPath must be a non-empty absolute path when provided');
    expect(spawnCalls).toHaveLength(0);
  });
});
