import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createJsonlTransport } from '../jsonl-transport.js';
import type { IJsonlTransport } from '../types.js';

/**
 * Wait for the child's `close` event. Unlike `events.once`, this does not
 * reject on the child's `error` event, which a failed spawn emits first.
 * @param child - Child process to observe.
 * @returns Promise that resolves once the child has closed.
 */
function closed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once('close', () => resolve()));
}

describe('createJsonlTransport', () => {
  let transport: IJsonlTransport | undefined;

  afterEach(() => {
    transport?.close();
    transport = undefined;
    vi.restoreAllMocks();
  });

  it('should spawn a process and parse JSONL from stdout', async () => {
    transport = createJsonlTransport({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ hello: "world" }) + "\\n")'],
      cwd: process.cwd(),
      processName: 'test-echo',
    });

    const message = await new Promise<unknown>((resolve) => {
      transport!.onMessage((msg) => resolve(msg));
    });

    expect(message).toEqual({ hello: 'world' });
  });

  it('should support multiple message listeners', async () => {
    transport = createJsonlTransport({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ a: 1 }) + "\\n")'],
      cwd: process.cwd(),
    });

    const results: unknown[] = [];
    const done = Promise.all([
      new Promise<void>((resolve) => {
        transport!.onMessage((msg) => {
          results.push(msg);
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        transport!.onMessage((msg) => {
          results.push(msg);
          resolve();
        });
      }),
    ]);

    await done;
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ a: 1 });
    expect(results[1]).toEqual({ a: 1 });
  });

  it('should return unsubscribe functions', async () => {
    transport = createJsonlTransport({
      command: 'node',
      args: [
        '-e',
        'process.stdout.write(\'{"a":1}\\n\'); setTimeout(() => process.stdout.write(\'{"b":2}\\n\'), 100);',
      ],
      cwd: process.cwd(),
    });

    const first: unknown[] = [];
    const second: unknown[] = [];

    const unsub = transport.onMessage((msg) => first.push(msg));
    transport.onMessage((msg) => second.push(msg));

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (first.length >= 1) {
          unsub();
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it('should call error listeners on non-zero exit', async () => {
    transport = createJsonlTransport({
      command: 'node',
      args: ['-e', 'process.exit(1)'],
      cwd: process.cwd(),
      processName: 'test-exit',
    });

    const error = await new Promise<Error>((resolve) => {
      transport!.onError((err) => resolve(err));
    });

    expect(error.message).toContain('test-exit');
    expect(error.message).toContain('exited');
  });

  it('should call error listeners when the process is killed by a signal it did not get from close()', async () => {
    transport = createJsonlTransport({
      command: process.execPath,
      args: ['-e', 'process.kill(process.pid, "SIGKILL")'],
      cwd: process.cwd(),
      processName: 'test-signal',
    });

    const error = await new Promise<Error>((resolve) => {
      transport!.onError((err) => resolve(err));
    });

    expect(error.message).toBe('test-signal exited with signal SIGKILL');
  });

  it('reports a clean exit the transport did not request', async () => {
    transport = createJsonlTransport({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      processName: 'test-clean-exit',
    });

    const error = await new Promise<Error>((resolve) => {
      transport!.onError((err) => resolve(err));
    });

    expect(error.message).toBe('test-clean-exit exited with code 0');
  });

  it('reports a process that could not be spawned exactly once, with the spawn error', async () => {
    transport = createJsonlTransport({
      command: '/definitely/missing/jsonl-binary',
      cwd: process.cwd(),
      processName: 'test-missing',
    });
    const errors: Error[] = [];
    transport.onError((err) => errors.push(err));

    // The transport's own `close` handler was registered first, so it has run
    // by the time this one resolves.
    await closed(transport.process);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('ENOENT');
  });

  it('notifies every error listener even when an earlier one closes the transport', async () => {
    transport = createJsonlTransport({
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      cwd: process.cwd(),
      processName: 'test-close-in-listener',
    });
    const closingTransport = transport;
    const observed: Error[] = [];
    closingTransport.onError(() => closingTransport.close());
    closingTransport.onError((err) => observed.push(err));

    await closed(closingTransport.process);

    expect(observed.map((err) => err.message)).toEqual(['test-close-in-listener exited with code 1']);
  });

  it('isolates a throwing message listener from later listeners', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    transport = createJsonlTransport({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ a: 1 }) + "\\n")'],
      cwd: process.cwd(),
      processName: 'test-throwing-listener',
    });

    const errors: Error[] = [];
    transport.onError((err) => errors.push(err));
    transport.onMessage(() => {
      throw new Error('listener failed');
    });
    const message = await new Promise<unknown>((resolve) => {
      transport!.onMessage((msg) => resolve(msg));
    });

    expect(message).toEqual({ a: 1 });
    expect(errors).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith('[test-throwing-listener] transport listener threw', expect.any(Error));
  });

  it('drops invalid JSON lines without reporting a transport error or logging the line', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport = createJsonlTransport({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("not-json token=secret-value\\n" + JSON.stringify({ after: true }) + "\\n")'],
      cwd: process.cwd(),
      processName: 'test-bad-json',
    });

    const errors: Error[] = [];
    transport.onError((err) => errors.push(err));
    const message = await new Promise<unknown>((resolve) => {
      transport!.onMessage((msg) => resolve(msg));
    });

    expect(message).toEqual({ after: true });
    expect(errors).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith('[test-bad-json] dropped 1 malformed JSONL line(s) from stdout');
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-value');
  });

  it('should preserve parent environment variables when child env is provided', async () => {
    const parentKey = 'MAKAIO_JSONL_PARENT_MARKER';
    const previousParentValue = process.env[parentKey];
    process.env[parentKey] = 'from-parent';

    try {
      transport = createJsonlTransport({
        command: process.execPath,
        args: [
          '-e',
          `
process.stdout.write(JSON.stringify({
  parent: process.env.${parentKey},
  child: process.env.MAKAIO_JSONL_CHILD_MARKER,
  removed: Object.prototype.hasOwnProperty.call(process.env, 'MAKAIO_JSONL_REMOVED_MARKER')
}) + '\\n');
`,
        ],
        cwd: process.cwd(),
        env: {
          MAKAIO_JSONL_CHILD_MARKER: 'from-child',
          MAKAIO_JSONL_REMOVED_MARKER: undefined,
        },
      });

      const message = await new Promise<unknown>((resolve) => {
        transport!.onMessage((msg) => resolve(msg));
      });

      expect(message).toEqual({
        parent: 'from-parent',
        child: 'from-child',
        removed: false,
      });
    } finally {
      if (previousParentValue === undefined) {
        delete process.env[parentKey];
      } else {
        process.env[parentKey] = previousParentValue;
      }
    }
  });

  it('should handle multi-line JSONL output', async () => {
    transport = createJsonlTransport({
      command: 'node',
      args: ['-e', 'process.stdout.write(\'{"x":1}\\n{"x":2}\\n{"x":3}\\n\')'],
      cwd: process.cwd(),
    });

    const messages: unknown[] = [];
    await new Promise<void>((resolve) => {
      transport!.onMessage((msg) => {
        messages.push(msg);
        if (messages.length === 3) resolve();
      });
    });

    expect(messages).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  });
});
