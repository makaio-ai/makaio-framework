import { describe, expect, it } from 'vitest';
import { TerminalManager } from '../terminal-manager.js';

describe('TerminalManager', () => {
  it('waits for stream closure before reporting exit and returning output', async () => {
    const manager = new TerminalManager();
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
    const manager = new TerminalManager();
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
    const manager = new TerminalManager();

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
});
