/**
 * Environment forwarding tests for {@link NodePtyBackend}.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeBridgeBackend } from '../node-bridge-backend.js';
import { NodePtyBackend } from '../node-pty-backend.js';

const mockPtySpawn = vi.hoisted(() => vi.fn());
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn,
}));

function createPtyProcess() {
  return {
    pid: 1,
    process: '/bin/echo',
    cols: 80,
    rows: 24,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  };
}

describe('NodePtyBackend environment forwarding', () => {
  beforeEach(() => {
    vi.stubEnv('HARMLESS_NODE_PTY_PARENT_ENV', 'inherited-value');
    vi.stubEnv('NODE_PTY_BACKEND_ENV_OVERRIDE', 'parent-value');
    vi.stubEnv('PATH', '/inherited/test-path');
    mockPtySpawn.mockReturnValue(createPtyProcess());
  });

  afterEach(() => {
    mockPtySpawn.mockReset();
    vi.unstubAllEnvs();
  });

  it('uses a supplied environment exactly by default', async () => {
    const backend = new NodePtyBackend();

    await backend.spawn('/bin/echo', [], {
      env: {
        NODE_PTY_BACKEND_ENV_OVERRIDE: 'explicit-value',
        EXPLICIT_PTY_ENV: 'explicit-only-value',
      },
    });

    expect(mockPtySpawn).toHaveBeenCalledWith('/bin/echo', [], {
      env: {
        NODE_PTY_BACKEND_ENV_OVERRIDE: 'explicit-value',
        EXPLICIT_PTY_ENV: 'explicit-only-value',
      },
    });
  });

  it('inherits the parent environment only when explicitly requested', async () => {
    const backend = new NodePtyBackend();

    await backend.spawn('/bin/echo', [], {
      env: { NODE_PTY_BACKEND_ENV_OVERRIDE: 'explicit-value' },
      inheritEnvironment: true,
    });

    expect(mockPtySpawn).toHaveBeenCalledWith(
      '/bin/echo',
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          HARMLESS_NODE_PTY_PARENT_ENV: 'inherited-value',
          NODE_PTY_BACKEND_ENV_OVERRIDE: 'explicit-value',
          PATH: '/inherited/test-path',
        }),
      }),
    );
  });

  it('leaves environment inheritance to node-pty when no environment is supplied', async () => {
    const backend = new NodePtyBackend();

    await backend.spawn('/bin/echo', [], {});

    expect(mockPtySpawn).toHaveBeenCalledWith('/bin/echo', [], {});
  });
});

describeOnPosix('NodeBridgeBackend environment forwarding', () => {
  it('uses a supplied environment exactly by default in the bridge child', async () => {
    vi.stubEnv('HARMLESS_NODE_PTY_PARENT_ENV', 'inherited-value');
    vi.stubEnv('NODE_PTY_BACKEND_ENV_OVERRIDE', 'parent-value');
    const backend = new NodeBridgeBackend();

    try {
      const pty = await backend.spawn(
        '/bin/sh',
        [
          '-c',
          'read _; if [ -z "${HARMLESS_NODE_PTY_PARENT_ENV+x}" ] && [ "$NODE_PTY_BACKEND_ENV_OVERRIDE" = explicit-value ] && [ "$PATH" = /explicit/test-path ]; then printf bridge-env-exact-ok; else printf bridge-env-exact-failed; fi',
        ],
        { env: { NODE_PTY_BACKEND_ENV_OVERRIDE: 'explicit-value', PATH: '/explicit/test-path' } },
      );
      const output: string[] = [];
      let exitCode: number | undefined;
      pty.onData((data) => output.push(data));
      pty.onExit((event) => {
        exitCode = event.exitCode;
      });

      pty.write('\n');
      await vi.waitFor(() => {
        expect(output.join('')).toContain('bridge-env-exact-ok');
        expect(exitCode).toBe(0);
      });
    } finally {
      await backend.dispose();
      vi.unstubAllEnvs();
    }
  });

  it('merges the parent environment in the bridge child without exposing it in transport output', async () => {
    vi.stubEnv('HARMLESS_NODE_PTY_PARENT_ENV', 'inherited-value');
    vi.stubEnv('NODE_PTY_BACKEND_ENV_OVERRIDE', 'parent-value');
    vi.stubEnv('PATH', '/inherited/test-path');
    const backend = new NodeBridgeBackend();

    try {
      const pty = await backend.spawn(
        '/bin/sh',
        [
          '-c',
          'read _; if [ "$HARMLESS_NODE_PTY_PARENT_ENV" = inherited-value ] && [ "$NODE_PTY_BACKEND_ENV_OVERRIDE" = explicit-value ] && [ "$PATH" = /inherited/test-path ]; then printf bridge-env-ok; else printf bridge-env-failed; fi',
        ],
        { env: { NODE_PTY_BACKEND_ENV_OVERRIDE: 'explicit-value' }, inheritEnvironment: true },
      );
      const output: string[] = [];
      let exitCode: number | undefined;
      pty.onData((data) => output.push(data));
      pty.onExit((event) => {
        exitCode = event.exitCode;
      });

      pty.write('\n');
      await vi.waitFor(() => {
        expect(output.join('')).toContain('bridge-env-ok');
        expect(exitCode).toBe(0);
      });
    } finally {
      await backend.dispose();
      vi.unstubAllEnvs();
    }
  });
});
