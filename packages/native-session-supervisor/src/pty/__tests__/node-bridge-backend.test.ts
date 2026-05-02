/**
 * Tests for NodeBridgeBackend — JSON-RPC bridge protocol, Bun and Node
 * subprocess spawning, and disposal lifecycle.
 */

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeBridgeBackend } from '../node-bridge-backend.js';

// ── child_process mock (used by the spawnViaNode code path) ───────────────────

const mockChildProcessSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: mockChildProcessSpawn,
}));

// ── Fake Bun bridge process ───────────────────────────────────────────────────

interface FakeBunProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly flushSpawned: () => void;
  readonly emitEvent: (event: Record<string, unknown>) => void;
  readonly commands: Array<{ id: number; cmd: string }>;
}

interface FakeBunGlobal {
  spawn: ReturnType<typeof vi.fn>;
  which?: ReturnType<typeof vi.fn>;
}

function createBridgeProcess(autoRespondSpawn = true): FakeBunProcess {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let pendingSpawnId: number | null = null;
  const commands: Array<{ id: number; cmd: string }> = [];

  const emitEvent = (event: Record<string, unknown>) => {
    stdoutController?.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
  };

  const flushSpawned = () => {
    if (pendingSpawnId === null) {
      return;
    }

    emitEvent({
      id: pendingSpawnId,
      event: 'spawned',
      ptyId: 1,
      pid: 321,
      process: '/bin/bash',
    });
    pendingSpawnId = null;
  };

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutController = controller;
    },
  });

  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      const text = decoder.decode(chunk);
      const command = JSON.parse(text.trim()) as { id: number; cmd: string };
      commands.push(command);

      if (command.cmd === 'spawn') {
        pendingSpawnId = command.id;
        if (autoRespondSpawn) {
          flushSpawned();
        }
      }
    },
  });

  return {
    stdin,
    stdout,
    kill: vi.fn(),
    flushSpawned,
    emitEvent,
    commands,
  };
}

function setBunGlobal(bun: FakeBunGlobal): void {
  Object.assign(globalThis as Record<string, unknown>, {
    Bun: {
      which: vi.fn().mockReturnValue('/usr/bin/node'),
      ...bun,
    } satisfies FakeBunGlobal,
  });
}

function clearBunGlobal(): void {
  delete (globalThis as Record<string, unknown>)['Bun'];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeBridgeBackend', () => {
  afterEach(() => {
    clearBunGlobal();
    vi.unstubAllEnvs();
    mockChildProcessSpawn.mockReset();
  });

  it('retries bridge startup after a failed launch instead of latching the rejected promise', async () => {
    const process = createBridgeProcess();
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('bridge failed to start');
      })
      .mockImplementationOnce(() => process);

    setBunGlobal({ spawn });

    const backend = new NodeBridgeBackend();

    await expect(backend.spawn('/bin/bash', [], {})).rejects.toThrow('bridge failed to start');

    const pty = await backend.spawn('/bin/bash', [], {});

    expect(pty.pid).toBe(321);
    expect(pty.process).toBe('/bin/bash');
    expect(spawn).toHaveBeenCalledTimes(2);

    await backend.dispose();
  });

  it('rejects spawn when teardown wins the race with bridge startup', async () => {
    const process = createBridgeProcess(false);
    const spawn = vi.fn().mockReturnValue(process);

    setBunGlobal({ spawn });

    const backend = new NodeBridgeBackend();
    const pendingSpawn = backend.spawn('/bin/bash', [], {});

    await backend.dispose();
    process.flushSpawned();

    await expect(pendingSpawn).rejects.toThrow('NodeBridgeBackend is not available');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('makes exited PTY handles inert so stale controls do not target reused ids', async () => {
    const process = createBridgeProcess();
    const spawn = vi.fn().mockReturnValue(process);
    setBunGlobal({ spawn });

    const backend = new NodeBridgeBackend();
    const pty = await backend.spawn('/bin/bash', [], {});
    expect(process.commands).toHaveLength(1);

    const exitSeen = new Promise<void>((resolve) => {
      pty.onExit(() => resolve());
    });

    process.emitEvent({ ptyId: 1, event: 'exit', exitCode: 0, signal: 0 });
    await exitSeen;

    pty.write('echo hello');
    pty.resize(120, 40);
    pty.kill('SIGTERM');

    expect(process.commands).toHaveLength(1);

    await backend.dispose();
  });

  it('snapshots terminal dimensions before the async spawn result resolves', async () => {
    const process = createBridgeProcess(false);
    const spawn = vi.fn().mockReturnValue(process);
    setBunGlobal({ spawn });

    const backend = new NodeBridgeBackend();
    const options = { cols: 90, rows: 30 };
    const pendingSpawn = backend.spawn('/bin/bash', [], options);

    await vi.waitFor(() => {
      expect(process.commands).toHaveLength(1);
    });

    options.cols = 140;
    options.rows = 60;
    process.flushSpawned();

    const pty = await pendingSpawn;
    expect(pty.cols).toBe(90);
    expect(pty.rows).toBe(30);

    await backend.dispose();
  });

  it('uses an explicit Node executable when the Bun host config provides one', async () => {
    const process = createBridgeProcess();
    const spawn = vi.fn().mockReturnValue(process);
    setBunGlobal({ spawn });
    vi.stubEnv('MAKAIO_NODE_EXECUTABLE', '/custom/node');

    const backend = new NodeBridgeBackend();
    await backend.spawn('/bin/bash', [], {});

    expect(spawn).toHaveBeenCalledWith(['/custom/node', expect.stringContaining('pty-bridge.cjs')], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });

    await backend.dispose();
  });

  it('fails fast when Bun hosts cannot resolve a Node executable for the bridge', async () => {
    const spawn = vi.fn();
    const which = vi.fn().mockReturnValue(null);
    setBunGlobal({ spawn, which });

    const backend = new NodeBridgeBackend();

    await expect(backend.spawn('/bin/bash', [], {})).rejects.toThrow(
      'NodeBridgeBackend requires MAKAIO_NODE_EXECUTABLE or a discoverable node executable on PATH when running under Bun.',
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  // ── spawnViaNode code path (Bun global absent) ──────────────────────────────

  it('reaches child_process.spawn when the Bun global is absent', async () => {
    // No setBunGlobal() call — Bun is absent in this test.
    const stdout = new PassThrough();
    const stdinWrites: string[] = [];
    const fakeChild = {
      stdin: { write: (text: string) => stdinWrites.push(text) },
      stdout,
      kill: vi.fn(),
    };
    mockChildProcessSpawn.mockReturnValueOnce(fakeChild);

    const backend = new NodeBridgeBackend();

    // Begin spawn — this triggers ensureBridge() → spawnViaNode().
    // The backend waits for the bridge to reply with a 'spawned' event before
    // resolving, so push the response once the spawn command has been written.
    const spawnPromise = backend.spawn('/bin/bash', [], { cols: 80, rows: 24 });

    // Wait until the backend writes the 'spawn' command to stdin, then reply.
    await vi.waitFor(() => {
      expect(stdinWrites).toHaveLength(1);
    });

    const command = JSON.parse(stdinWrites[0]!.trim()) as { id: number; cmd: string };
    expect(command.cmd).toBe('spawn');

    stdout.push(`${JSON.stringify({ id: command.id, event: 'spawned', ptyId: 1, pid: 555, process: '/bin/bash' })}\n`);

    const pty = await spawnPromise;

    expect(mockChildProcessSpawn).toHaveBeenCalledOnce();
    expect(mockChildProcessSpawn).toHaveBeenCalledWith(process.execPath, [expect.stringContaining('pty-bridge.cjs')], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    expect(pty.pid).toBe(555);
    expect(pty.process).toBe('/bin/bash');

    await backend.dispose();
  });

  it('exposes a working writeStdin and kill on the Node bridge process', async () => {
    // No setBunGlobal() — tests the Node (non-Bun) code path.
    const stdout = new PassThrough();
    const stdinWrites: string[] = [];
    const killMock = vi.fn();
    const fakeChild = {
      stdin: { write: (text: string) => stdinWrites.push(text) },
      stdout,
      kill: killMock,
    };
    mockChildProcessSpawn.mockReturnValueOnce(fakeChild);

    const backend = new NodeBridgeBackend();
    const spawnPromise = backend.spawn('/bin/bash', [], {});

    await vi.waitFor(() => {
      expect(stdinWrites).toHaveLength(1);
    });

    const command = JSON.parse(stdinWrites[0]!.trim()) as { id: number; cmd: string };
    stdout.push(`${JSON.stringify({ id: command.id, event: 'spawned', ptyId: 2, pid: 777, process: '/bin/zsh' })}\n`);

    const pty = await spawnPromise;
    expect(pty.pid).toBe(777);

    // dispose() calls bridge.kill('SIGTERM'), which maps to child.kill('SIGTERM').
    await backend.dispose();
    expect(killMock).toHaveBeenCalledWith('SIGTERM');
  });

  it('routes bridge data events through the onData pipeline to registered listeners', async () => {
    // Verifies the output streaming path: a `data` event emitted by the bridge
    // subprocess (base64-encoded latin1) is decoded and forwarded to every
    // onData listener registered on the returned IPtyProcess handle.
    const process = createBridgeProcess();
    const spawn = vi.fn().mockReturnValue(process);
    setBunGlobal({ spawn });

    const backend = new NodeBridgeBackend();
    const pty = await backend.spawn('/bin/bash', [], {});

    const received: string[] = [];
    pty.onData((data) => received.push(data));

    // Encode the expected output as base64 (latin1) — matching the bridge wire
    // format defined in node-bridge-backend.ts dispatch('data').
    const expectedText = 'hello from pty\r\n';
    const encoded = Buffer.from(expectedText, 'latin1').toString('base64');

    process.emitEvent({ ptyId: 1, event: 'data', data: encoded });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });

    expect(received[0]).toBe(expectedText);

    await backend.dispose();
  });

  it('delivers data events to multiple independent onData listeners', async () => {
    // Verifies fan-out: all registered listeners receive every data chunk.
    const process = createBridgeProcess();
    const spawn = vi.fn().mockReturnValue(process);
    setBunGlobal({ spawn });

    const backend = new NodeBridgeBackend();
    const pty = await backend.spawn('/bin/bash', [], {});

    const firstReceived: string[] = [];
    const secondReceived: string[] = [];
    pty.onData((data) => firstReceived.push(data));
    pty.onData((data) => secondReceived.push(data));

    const chunk = 'output chunk';
    const encoded = Buffer.from(chunk, 'latin1').toString('base64');
    process.emitEvent({ ptyId: 1, event: 'data', data: encoded });

    await vi.waitFor(() => {
      expect(firstReceived).toHaveLength(1);
    });

    expect(firstReceived[0]).toBe(chunk);
    expect(secondReceived[0]).toBe(chunk);

    await backend.dispose();
  });

  it('does not deliver data events to a disposed onData listener', async () => {
    // Verifies that the disposable returned by onData() correctly removes the
    // listener so it no longer receives subsequent data events.
    const process = createBridgeProcess();
    const spawn = vi.fn().mockReturnValue(process);
    setBunGlobal({ spawn });

    const backend = new NodeBridgeBackend();
    const pty = await backend.spawn('/bin/bash', [], {});

    const received: string[] = [];
    const disposable = pty.onData((data) => received.push(data));

    // Dispose immediately — no events should be received after this.
    disposable.dispose();

    const encoded = Buffer.from('should not arrive', 'latin1').toString('base64');
    process.emitEvent({ ptyId: 1, event: 'data', data: encoded });

    // Yield to the I/O event loop so the stream reader and readline interface
    // have a chance to process the enqueued chunk before we assert absence.
    // setImmediate fires after I/O callbacks in the current event-loop turn,
    // which is deterministic and avoids a wall-clock timeout.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(received).toHaveLength(0);

    await backend.dispose();
  });
});
