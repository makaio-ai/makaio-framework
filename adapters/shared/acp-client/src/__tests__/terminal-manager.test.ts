import { describe, expect, it } from 'vitest';
import { TerminalManager } from '../terminal-manager.js';

describe('TerminalManager', () => {
  it('waits for stream closure before reporting exit and returning output', async () => {
    const manager = new TerminalManager({ baseEnv: {} });
    const payload = 'x'.repeat(1024 * 1024);

    const { terminalId } = await manager.createTerminal({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(1024 * 1024))"],
      outputByteLimit: 2 * 1024 * 1024,
      env: [],
      sessionId: 'session-1',
    });

    await expect(manager.waitForExit({ terminalId, sessionId: 'session-1' })).resolves.toEqual({
      exitCode: 0,
      signal: undefined,
    });
    await expect(manager.getOutput({ terminalId, sessionId: 'session-1' })).resolves.toEqual({
      output: payload,
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
    });
  });

  it('truncates buffered output without splitting UTF-8 characters', async () => {
    const manager = new TerminalManager({ baseEnv: {} });
    const repeated = '€'.repeat(10);

    const { terminalId } = await manager.createTerminal({
      command: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(repeated)})`],
      outputByteLimit: 10,
      env: [],
      sessionId: 'session-1',
    });

    await manager.waitForExit({ terminalId, sessionId: 'session-1' });

    await expect(manager.getOutput({ terminalId, sessionId: 'session-1' })).resolves.toEqual({
      output: '€€€',
      truncated: true,
      exitStatus: { exitCode: 0, signal: null },
    });
  });

  it('rejects terminal creation when the command cannot be spawned', async () => {
    const manager = new TerminalManager({ baseEnv: {} });

    await expect(
      manager.createTerminal({
        command: '/definitely/missing/binary',
        args: [],
        outputByteLimit: 1024,
        env: [],
        sessionId: 'session-1',
      }),
    ).rejects.toThrow();
  });

  it('uses only the scrubbed base and permitted request overlay for real terminal processes', async () => {
    const ambientName = `MAKAIO_AMBIENT_SECRET_${crypto.randomUUID().replaceAll('-', '_')}`;
    process.env[ambientName] = 'ambient-secret';
    const manager = new TerminalManager({
      baseEnv: {
        MAKAIO_SELECTED_ENV: 'selected-value',
        OPENAI_API_KEY: 'must-be-scrubbed-from-base',
        MAKAIO_REQUEST_OVERRIDE: 'base-value',
      },
      scrubEnvVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    });

    try {
      const script = `process.stdout.write(JSON.stringify({
        ambient: process.env[${JSON.stringify(ambientName)}],
        selected: process.env.MAKAIO_SELECTED_ENV,
        blockedBase: process.env.OPENAI_API_KEY,
        blockedRequest: process.env.ANTHROPIC_API_KEY,
        override: process.env.MAKAIO_REQUEST_OVERRIDE,
        requestOnly: process.env.MAKAIO_REQUEST_ONLY,
      }))`;
      const { terminalId } = await manager.createTerminal({
        command: process.execPath,
        args: ['-e', script],
        env: [
          { name: 'ANTHROPIC_API_KEY', value: 'must-be-scrubbed-from-request' },
          { name: 'MAKAIO_REQUEST_OVERRIDE', value: 'request-value' },
          { name: 'MAKAIO_REQUEST_ONLY', value: 'request-only-value' },
        ],
        sessionId: 'session-1',
      });

      await manager.waitForExit({ terminalId, sessionId: 'session-1' });
      const output = await manager.getOutput({ terminalId, sessionId: 'session-1' });
      const parsedOutput: unknown = JSON.parse(output.output);

      expect(parsedOutput).toEqual({
        selected: 'selected-value',
        override: 'request-value',
        requestOnly: 'request-only-value',
      });
      await manager.releaseTerminal({ terminalId, sessionId: 'session-1' });
    } finally {
      delete process.env[ambientName];
      manager.releaseAll();
    }
  });
});
