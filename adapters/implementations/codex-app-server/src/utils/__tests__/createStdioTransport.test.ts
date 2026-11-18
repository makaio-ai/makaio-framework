import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStdioTransport } from '../createStdioTransport.js';

/**
 * Mock subprocess for testing
 */
class MockSubprocess {
  stdin = {
    write: vi.fn(),
  };

  stdout = {
    on: vi.fn(),
  };

  stderr = {
    on: vi.fn(),
  };

  on = vi.fn();

  kill = vi.fn();

  // A live ChildProcess reports `null` for both until it has ended.
  exitCode: number | null = null;

  signalCode: NodeJS.Signals | null = null;
}

/**
 * Mock spawn function
 */
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

describe('createStdioTransport', () => {
  let mockSubprocess: MockSubprocess;

  beforeEach(() => {
    mockSubprocess = new MockSubprocess();
    mockSpawn.mockReturnValue(mockSubprocess);
    vi.clearAllMocks();
  });

  it('should spawn codex app-server subprocess with correct arguments', () => {
    createStdioTransport('/test/cwd', { PATH: '/usr/bin', HOME: undefined });

    expect(mockSpawn).toHaveBeenCalledWith('codex', ['app-server'], {
      cwd: '/test/cwd',
      env: expect.objectContaining({
        PATH: '/usr/bin',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(mockSpawn.mock.calls[0][2].env).not.toHaveProperty('RUST_LOG');
  });

  // createStdioTransport is a thin wrapper around spawn() — asserting spawn
  // arguments IS the behavior under test. Real process spawning is not viable
  // in unit tests for this layer.
  it('should spawn the resolved binary when binaryPath is provided', () => {
    createStdioTransport('/test/cwd', {}, '/usr/local/bin/codex-managed');

    expect(mockSpawn).toHaveBeenCalledWith('/usr/local/bin/codex-managed', ['app-server'], expect.any(Object));
  });

  it('should fall back to codex when binaryPath is undefined', () => {
    createStdioTransport('/test/cwd', {}, undefined);

    expect(mockSpawn).toHaveBeenCalledWith('codex', ['app-server'], expect.any(Object));
  });

  it('should reject an empty binaryPath before spawning', () => {
    expect(() => createStdioTransport('/test/cwd', {}, '   ')).toThrow(
      'binaryPath must be a non-empty absolute path when provided',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should reject a relative binaryPath before spawning', () => {
    expect(() => createStdioTransport('/test/cwd', {}, 'bin/codex')).toThrow(
      'binaryPath must be a non-empty absolute path when provided',
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should filter out undefined environment variables', () => {
    createStdioTransport('/test/cwd', {
      PATH: '/usr/bin',
      HOME: undefined,
      UNDEFINED_VAR: undefined,
    });

    const envArg = mockSpawn.mock.calls[0][2].env;
    expect(envArg).not.toHaveProperty('HOME');
    expect(envArg).not.toHaveProperty('UNDEFINED_VAR');
    expect(envArg).toHaveProperty('PATH', '/usr/bin');
  });

  it('should parse single complete JSONL message', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const messages: unknown[] = [];

    transport.onMessage((message) => messages.push(message));

    // Get the stdout data callback
    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];
    stdoutOnCallback(Buffer.from('{"method":"test","params":{}}\n'));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ method: 'test', params: {} });
  });

  it('should parse multiple JSONL messages in one chunk', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const messages: unknown[] = [];

    transport.onMessage((message) => messages.push(message));

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];
    stdoutOnCallback(Buffer.from('{"method":"test1","params":{}}\n{"method":"test2","params":{}}\n'));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ method: 'test1', params: {} });
    expect(messages[1]).toEqual({ method: 'test2', params: {} });
  });

  it('should buffer incomplete JSONL line', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const messages: unknown[] = [];

    transport.onMessage((message) => messages.push(message));

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];

    // Send incomplete line
    stdoutOnCallback(Buffer.from('{"method":"test","'));

    expect(messages).toHaveLength(0);

    // Send rest of line
    stdoutOnCallback(Buffer.from('params":{}}\n'));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ method: 'test', params: {} });
  });

  it('should handle JSONL split across chunk boundaries', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const messages: unknown[] = [];

    transport.onMessage((message) => messages.push(message));

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];

    // Split message across two chunks
    stdoutOnCallback(Buffer.from('{"method":"test","params'));
    stdoutOnCallback(Buffer.from('":{}}\n'));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ method: 'test', params: {} });
  });

  it('should handle multiple complete lines with trailing incomplete line', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const messages: unknown[] = [];

    transport.onMessage((message) => messages.push(message));

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];

    // Two complete lines + incomplete line
    stdoutOnCallback(Buffer.from('{"method":"test1","params":{}}\n{"method":"test2","params":{}}\n{"method":"test3"'));

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ method: 'test1', params: {} });
    expect(messages[1]).toEqual({ method: 'test2', params: {} });

    // Complete the third line
    stdoutOnCallback(Buffer.from(',"params":{}}\n'));

    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ method: 'test3', params: {} });
  });

  it('should ignore empty lines', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const messages: unknown[] = [];

    transport.onMessage((message) => messages.push(message));

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];
    stdoutOnCallback(Buffer.from('\n\n{"method":"test","params":{}}\n\n\n'));

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ method: 'test', params: {} });
  });

  it('drops invalid JSON lines without failing the transport', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = createStdioTransport('/test/cwd', {});
    const errors: Error[] = [];
    const messages: unknown[] = [];

    transport.onError((error) => errors.push(error));
    transport.onMessage((message) => messages.push(message));

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];
    stdoutOnCallback(Buffer.from('invalid json\n{"method":"after","params":{}}\n'));

    expect(errors).toHaveLength(0);
    expect(messages).toEqual([{ method: 'after', params: {} }]);
    expect(warnSpy).toHaveBeenCalledWith('[codex app-server] dropped 1 malformed JSONL line(s)');

    warnSpy.mockRestore();
  });

  it('reports a throwing message consumer as a transport failure', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const errors: Error[] = [];

    transport.onError((error) => errors.push(error));
    transport.onMessage(() => {
      throw new Error('consumer failed');
    });

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];
    stdoutOnCallback(Buffer.from('{"method":"test","params":{}}\n'));

    expect(errors.map((error) => error.message)).toEqual(['consumer failed']);
  });

  it('should send messages to stdin as JSONL', () => {
    const transport = createStdioTransport('/test/cwd', {});

    transport.send({ jsonrpc: '2.0', id: 1, method: 'test', params: {} });

    expect(mockSubprocess.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test', params: {} }) + '\n',
    );
  });

  it('should call error callback on subprocess error', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const errors: Error[] = [];

    transport.onError((error) => errors.push(error));

    const onCallback = mockSubprocess.on.mock.calls.find(([event]) => event === 'error')?.[1];
    onCallback?.(new Error('Subprocess failed'));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Subprocess failed');
  });

  it('should call error callback on subprocess exit with non-zero code', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const errors: Error[] = [];

    transport.onError((error) => errors.push(error));

    const onCallback = mockSubprocess.on.mock.calls.find(([event]) => event === 'exit')?.[1];
    onCallback?.(1);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('exited with code 1');
  });

  it('should call error callback on unrequested subprocess exit with code 0', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const errors: Error[] = [];

    transport.onError((error) => errors.push(error));

    const onCallback = mockSubprocess.on.mock.calls.find(([event]) => event === 'exit')?.[1];
    onCallback?.(0);

    expect(errors.map((error) => error.message)).toEqual(['codex app-server exited with code 0']);
  });

  it('should not call error callback on subprocess exit after a requested close', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const errors: Error[] = [];

    transport.onError((error) => errors.push(error));
    transport.close();

    const onCallback = mockSubprocess.on.mock.calls.find(([event]) => event === 'exit')?.[1];
    onCallback?.(0);

    expect(errors).toHaveLength(0);
  });

  it('should kill subprocess when close is called', () => {
    const transport = createStdioTransport('/test/cwd', {});

    transport.close();

    expect(mockSubprocess.kill).toHaveBeenCalled();
  });

  it('suppresses raw stderr and emits one bounded diagnostic', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    createStdioTransport('/test/cwd', {});

    const stderrOnCallback = mockSubprocess.stderr.on.mock.calls[0][1];
    stderrOnCallback(Buffer.from('secret-bearing stderr output\n'));
    stderrOnCallback(Buffer.from('another stderr chunk\n'));

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith('[codex app-server] stderr output suppressed');
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-bearing');

    warnSpy.mockRestore();
  });

  it('does not retain malformed protocol payloads in parse diagnostics', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createStdioTransport('/test/cwd', {});

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];
    stdoutOnCallback(Buffer.from('{"apiKey":"secret-value"\n'));

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-value');

    warnSpy.mockRestore();
  });

  it('delivers every message to every subscriber until it unsubscribes', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const messages1: unknown[] = [];
    const messages2: unknown[] = [];

    const unsubscribe1 = transport.onMessage((message) => messages1.push(message));
    transport.onMessage((message) => messages2.push(message));

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];
    stdoutOnCallback(Buffer.from('{"method":"first","params":{}}\n'));
    unsubscribe1();
    stdoutOnCallback(Buffer.from('{"method":"second","params":{}}\n'));

    expect(messages1).toEqual([{ method: 'first', params: {} }]);
    expect(messages2).toEqual([
      { method: 'first', params: {} },
      { method: 'second', params: {} },
    ]);
  });

  it('reports a failure to every error subscriber, even past one that unsubscribes or throws', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = createStdioTransport('/test/cwd', {});
    const errors: Error[] = [];

    const unsubscribe = transport.onError(() => unsubscribe());
    transport.onError(() => {
      throw new Error('subscriber failed');
    });
    transport.onError((error) => errors.push(error));

    const onCallback = mockSubprocess.on.mock.calls.find(([event]) => event === 'error')?.[1];
    onCallback?.(new Error('Test error'));
    onCallback?.(new Error('Second error'));

    expect(errors.map((error) => error.message)).toEqual(['Test error', 'Second error']);
    expect(errorSpy).toHaveBeenCalledWith('[codex app-server] transport error subscriber threw Error');

    errorSpy.mockRestore();
  });
});
