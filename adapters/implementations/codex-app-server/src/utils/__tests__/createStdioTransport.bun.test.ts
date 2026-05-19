/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import { createStdioTransport } from '../createStdioTransport.js';

/**
 * Mock subprocess for testing
 */
class MockSubprocess {
  stdin = {
    write: mock(),
  };

  stdout = {
    on: mock(),
  };

  stderr = {
    on: mock(),
  };

  on = mock();

  kill = mock();
}

/**
 * Mock spawn function
 */
const mockSpawn = mock();
mock.module('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

describe('createStdioTransport', () => {
  let mockSubprocess: MockSubprocess;

  beforeEach(() => {
    mockSubprocess = new MockSubprocess();
    mockSpawn.mockReturnValue(mockSubprocess);
    mock.clearAllMocks();
  });

  it('should spawn codex app-server subprocess with correct arguments', () => {
    createStdioTransport('/test/cwd', { PATH: '/usr/bin', HOME: undefined });

    expect(mockSpawn).toHaveBeenCalledWith('codex', ['app-server'], {
      cwd: '/test/cwd',
      env: expect.objectContaining({
        PATH: '/usr/bin',
        RUST_LOG: 'debug',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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

  it('should call error callback for invalid JSON', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const errors: Error[] = [];

    transport.onError((error) => errors.push(error));

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];
    stdoutOnCallback(Buffer.from('invalid json\n'));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBeTruthy();
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

  it('should not call error callback on subprocess exit with code 0', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const errors: Error[] = [];

    transport.onError((error) => errors.push(error));

    const onCallback = mockSubprocess.on.mock.calls.find(([event]) => event === 'exit')?.[1];
    onCallback?.(0);

    expect(errors).toHaveLength(0);
  });

  it('should kill subprocess when close is called', () => {
    const transport = createStdioTransport('/test/cwd', {});

    transport.close();

    expect(mockSubprocess.kill).toHaveBeenCalled();
  });

  it('should log stderr output to console.warn', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    createStdioTransport('/test/cwd', {});

    const stderrOnCallback = mockSubprocess.stderr.on.mock.calls[0][1];
    stderrOnCallback(Buffer.from('Test stderr output\n'));

    expect(warnSpy).toHaveBeenCalledWith('[codex app-server]', 'Test stderr output\n');

    warnSpy.mockRestore();
  });

  it('should allow registering multiple message callbacks', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const messages1: unknown[] = [];
    const messages2: unknown[] = [];

    transport.onMessage((message) => messages1.push(message));
    // Second callback replaces the first
    transport.onMessage((message) => messages2.push(message));

    const stdoutOnCallback = mockSubprocess.stdout.on.mock.calls[0][1];
    stdoutOnCallback(Buffer.from('{"method":"test","params":{}}\n'));

    // First callback should not be called (replaced by second)
    expect(messages1).toHaveLength(0);
    // Second callback should be called
    expect(messages2).toHaveLength(1);
  });

  it('should allow registering multiple error callbacks', () => {
    const transport = createStdioTransport('/test/cwd', {});
    const errors1: Error[] = [];
    const errors2: Error[] = [];

    transport.onError((error) => errors1.push(error));
    // Second callback replaces the first
    transport.onError((error) => errors2.push(error));

    const onCallback = mockSubprocess.on.mock.calls.find(([event]) => event === 'error')?.[1];
    onCallback?.(new Error('Test error'));

    // First callback should not be called (replaced by second)
    expect(errors1).toHaveLength(0);
    // Second callback should be called
    expect(errors2).toHaveLength(1);
  });
});
