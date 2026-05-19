/// <reference types="bun-types" />
import { beforeEach, afterEach, describe, expect, it, mock, jest } from 'bun:test';
import { advanceTimersByTimeAsync } from '@makaio/test-utils';
import { createStdioTransport } from './createStdioTransport.js';

class MockSubprocess {
  stdin = { end: mock() };
  stdout = { on: mock() };
  stderr = { on: mock() };
  on = mock();
  kill = mock();
}

const mockSpawn = mock();
mock.module('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

function createInitMessage() {
  return {
    uuid: 'u-1',
    session_id: 's-1',
    type: 'system',
    subtype: 'init',
    agentId: 'a-1',
    apiKeySource: 'user',
    cwd: '/tmp',
    tools: [],
    mcp_servers: [],
    model: 'sonnet',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
  };
}

/**
 * Creates a standard stdio transport test harness.
 * @param subprocess - Mocked subprocess backing the spawned transport.
 * @returns Test harness with transport, captured errors/messages, and stdout data handler.
 */
function setupStdioTest(subprocess: MockSubprocess) {
  const transport = createStdioTransport(['--print'], '/tmp', {});
  const errors: Error[] = [];
  const messages: unknown[] = [];
  transport.onError((error) => errors.push(error));
  transport.onMessage((message) => messages.push(message));
  const onStdout = subprocess.stdout.on.mock.calls.find(([event]) => event === 'data')?.[1] as
    | ((chunk: Buffer) => void)
    | undefined;
  return { transport, errors, messages, onStdout };
}

describe('createStdioTransport', () => {
  let subprocess: MockSubprocess;

  beforeEach(() => {
    subprocess = new MockSubprocess();
    mockSpawn.mockReturnValue(subprocess);
    mock.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports parse errors for invalid JSON lines', () => {
    const { errors, messages, onStdout } = setupStdioTest(subprocess);
    onStdout?.(Buffer.from('{not-valid-json}\n'));

    expect(messages).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Failed to parse JSONL');
  });

  it('normalizes CRLF lines before parsing', () => {
    const { errors, messages, onStdout } = setupStdioTest(subprocess);
    onStdout?.(Buffer.from(`${JSON.stringify(createInitMessage())}\r\n`));

    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
  });

  it('buffers messages emitted before callback registration', () => {
    const transport = createStdioTransport(['--print'], '/tmp', {});
    const messages: unknown[] = [];
    const onStdout = subprocess.stdout.on.mock.calls.find(([event]) => event === 'data')?.[1];

    onStdout?.(Buffer.from(`${JSON.stringify(createInitMessage())}\n`));
    transport.onMessage((message) => messages.push(message));

    expect(messages).toHaveLength(1);
  });

  it('uses binaryPath when provided', () => {
    createStdioTransport(['--print'], '/tmp', {}, '/custom/path/to/claude');
    expect(mockSpawn.mock.calls[0]?.[0]).toBe('/custom/path/to/claude');
  });

  it('falls back to "claude" when binaryPath is omitted', () => {
    createStdioTransport(['--print'], '/tmp', {});
    expect(mockSpawn.mock.calls[0]?.[0]).toBe('claude');
  });

  it('emits error and kills process when firstOutputTimeoutMs elapses with no stdout', async () => {
    jest.useFakeTimers();
    const transport = createStdioTransport(['--print'], '/tmp', {}, undefined, 5000);
    const errors: Error[] = [];
    transport.onError((error) => errors.push(error));

    await advanceTimersByTimeAsync(5000);

    expect(subprocess.kill).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('no output within 5000ms');
    expect(errors[0].message).toContain('--mcp-config');
    transport.close();
  });

  it('clears firstOutputTimeout when stdout data arrives before deadline', async () => {
    jest.useFakeTimers();
    const transport = createStdioTransport(['--print'], '/tmp', {}, undefined, 5000);
    const errors: Error[] = [];
    transport.onError((error) => errors.push(error));

    const onStdout = subprocess.stdout.on.mock.calls.find(([event]) => event === 'data')?.[1] as
      | ((chunk: Buffer) => void)
      | undefined;
    onStdout?.(Buffer.from(`${JSON.stringify(createInitMessage())}\n`));

    await advanceTimersByTimeAsync(5000);

    expect(subprocess.kill).not.toHaveBeenCalled();
    expect(errors).toHaveLength(0);
    transport.close();
  });

  it('clears firstOutputTimeout on explicit close() without emitting error', async () => {
    jest.useFakeTimers();
    const transport = createStdioTransport(['--print'], '/tmp', {}, undefined, 5000);
    const errors: Error[] = [];
    transport.onError((error) => errors.push(error));

    transport.close();
    await advanceTimersByTimeAsync(5000);

    expect(errors).toHaveLength(0);
  });

  it('preserves PATH fallback and strips CLAUDECODE from spawn env', () => {
    const previousPath = process.env['PATH'];
    const previousClaudeCode = process.env['CLAUDECODE'];

    try {
      process.env['PATH'] = '/usr/bin';
      process.env['CLAUDECODE'] = '1';
      createStdioTransport(['--print'], '/tmp', { CUSTOM_VAR: 'value', CLAUDECODE: '1' });

      const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { env: Record<string, string> } | undefined;
      expect(spawnOptions?.env['PATH']).toBe('/usr/bin');
      expect(spawnOptions?.env['CUSTOM_VAR']).toBe('value');
      expect(spawnOptions?.env['CLAUDECODE']).toBeUndefined();
    } finally {
      if (previousPath === undefined) {
        delete process.env['PATH'];
      } else {
        process.env['PATH'] = previousPath;
      }
      if (previousClaudeCode === undefined) {
        delete process.env['CLAUDECODE'];
      } else {
        process.env['CLAUDECODE'] = previousClaudeCode;
      }
    }
  });

  it('does not inject PATH when caller provides Path', () => {
    const previousPath = process.env['PATH'];

    try {
      process.env['PATH'] = '/usr/bin';
      createStdioTransport(['--print'], '/tmp', { Path: '/custom/bin' });

      const spawnOptions = mockSpawn.mock.calls[0]?.[2] as { env: Record<string, string> } | undefined;
      expect(spawnOptions?.env['Path']).toBe('/custom/bin');
      expect(spawnOptions?.env['PATH']).toBeUndefined();
    } finally {
      if (previousPath === undefined) {
        delete process.env['PATH'];
      } else {
        process.env['PATH'] = previousPath;
      }
    }
  });

  it('keeps remaining buffered messages if callback throws while draining', () => {
    const transport = createStdioTransport(['--print'], '/tmp', {});
    const onStdout = subprocess.stdout.on.mock.calls.find(([event]) => event === 'data')?.[1];
    const first = createInitMessage();
    const second = { ...createInitMessage(), uuid: 'u-2' };

    onStdout?.(Buffer.from(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`));

    expect(() =>
      transport.onMessage(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');

    const recovered: unknown[] = [];
    transport.onMessage((message) => recovered.push(message));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ uuid: 'u-2' });
  });

  it('flushes trailing buffered JSON on exit', () => {
    const transport = createStdioTransport(['--print'], '/tmp', {});
    const errors: Error[] = [];
    const messages: unknown[] = [];
    transport.onError((error) => errors.push(error));
    transport.onMessage((message) => messages.push(message));

    const onStdout = subprocess.stdout.on.mock.calls.find(([event]) => event === 'data')?.[1];
    onStdout?.(Buffer.from(JSON.stringify(createInitMessage())));

    const onExit = subprocess.on.mock.calls.find(([event]) => event === 'exit')?.[1];
    onExit?.(0);

    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
      session_id: 's-1',
    });
  });
});
