import { describe, it, expect, afterEach } from 'vitest';
import { createJsonlTransport } from '../jsonl-transport.js';
import type { IJsonlTransport } from '../types.js';

describe('createJsonlTransport', () => {
  let transport: IJsonlTransport | undefined;

  afterEach(() => {
    transport?.close();
    transport = undefined;
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

  it('should call error listeners on invalid JSON', async () => {
    transport = createJsonlTransport({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("not-json\\n")'],
      cwd: process.cwd(),
      processName: 'test-bad-json',
    });

    const error = await new Promise<Error>((resolve) => {
      transport!.onError((err) => resolve(err));
    });

    expect(error.message).toContain('parse');
    expect(error.message).toContain('test-bad-json');
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
