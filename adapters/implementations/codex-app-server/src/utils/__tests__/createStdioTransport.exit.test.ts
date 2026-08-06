/**
 * The Codex transport's exit observation and its kill-intention marker.
 *
 * Two separate facts are asserted here, and keeping them separate is the point:
 * the exit is always observable, and only its *promotion to a terminal error* is
 * withheld when this transport asked for the termination. A stub cannot show
 * either — the marker's whole difficulty is that a real signal, a real child and
 * a real callback can interleave — so every case spawns a real process.
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createStdioTransport, type StdioTransport } from '../createStdioTransport.js';

/**
 * Create a working directory holding an `app-server` script.
 *
 * The transport always spawns `<binary> app-server`, so the child's behaviour is
 * chosen by writing the script that name resolves to, and the real spawn path is
 * exercised unchanged.
 * @param source - Node source for the `app-server` script.
 * @returns Directory to pass as the transport's cwd.
 */
function appServerCwd(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-appserver-'));
  const script = join(dir, 'app-server');
  writeFileSync(script, source, 'utf8');
  chmodSync(script, 0o755);
  return dir;
}

/**
 * Collect everything the transport reports on its error channel.
 * @param transport - Transport to observe.
 * @returns Array receiving each reported error.
 */
function recordErrors(transport: StdioTransport): Error[] {
  const errors: Error[] = [];
  transport.onError((error) => errors.push(error));
  return errors;
}

describe('Codex transport exit observation', () => {
  it('settles the exit promise with the code the child reports', async () => {
    const cwd = appServerCwd('process.exit(9);\n');
    const transport = createStdioTransport(cwd, {}, process.execPath);

    await expect(transport.exited).resolves.toBe(9);
  });

  it('settles for a binary that never ran, so a retirement cannot wait on nothing', async () => {
    // The edge an `exit`-only observation cannot reach: a missing binary emits
    // `error` and `close` and no `exit` at all. `resetClient` retires this
    // transport by awaiting the promise, so one that never settles spends the whole
    // observation budget and then books an unobserved predecessor for a process
    // that never existed.
    const transport = createStdioTransport(process.cwd(), {}, '/definitely/missing/codex-binary');
    const errors = recordErrors(transport);

    // `null` is "ended without a code", the same fact a signalled termination
    // reports — the promise answers whether it is over, never why. The cause stays
    // on the error channel, which is where a failure to spawn belongs.
    await expect(transport.exited).resolves.toBeNull();
    expect(errors.some((error) => error.message.includes('ENOENT'))).toBe(true);
  });

  it('couples close() to the observation, so a requested close can be awaited', async () => {
    const cwd = appServerCwd('setInterval(() => {}, 1000);\n');
    const transport = createStdioTransport(cwd, {}, process.execPath);

    expect(transport.shutdownRequested()).toBe(false);
    transport.close();
    expect(transport.shutdownRequested()).toBe(true);

    await expect(transport.exited).resolves.toBeNull();
  });
});

describe('Codex transport expected-shutdown separation', () => {
  // Arm 1: the close this transport asked for.
  it('reports no terminal error for a signalled exit it requested', async () => {
    const cwd = appServerCwd('setInterval(() => {}, 1000);\n');
    const transport = createStdioTransport(cwd, {}, process.execPath);
    const errors = recordErrors(transport);

    transport.close();
    await transport.exited;

    expect(errors).toEqual([]);
  });

  // Arm 2: an unrequested death before any marker is set still reports.
  it('reports a terminal error for an unrequested non-zero exit', async () => {
    const cwd = appServerCwd('process.exit(4);\n');
    const transport = createStdioTransport(cwd, {}, process.execPath);
    const errors = recordErrors(transport);

    await transport.exited;

    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('exited with code 4');
  });

  // Arm 3: the overlap. The child ignores the signal and then dies on its own,
  // so the exit callback lands *after* the marker for a cause the marker did not
  // create. The contract's answer is that the exit is reported as an exit and no
  // terminal error is surfaced — and that this is indistinguishable from arm 1
  // by design, because the marker proves intent and never causation.
  it('reports no terminal error when an unrelated death lands after the marker', async () => {
    const cwd = appServerCwd(
      [
        // The handler must be installed before the signal arrives, so the child
        // announces itself and the test waits for that announcement. Killing a
        // process that has not reached its own first line proves nothing about
        // overlap — it is just arm 1 again.
        "process.on('SIGTERM', () => {});",
        "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\\n');",
        'setTimeout(() => process.exit(23), 250);',
        '',
      ].join('\n'),
    );
    const transport = createStdioTransport(cwd, {}, process.execPath);
    const errors = recordErrors(transport);
    const ready = new Promise<void>((resolve) => {
      transport.onMessage(() => resolve());
    });

    await ready;
    transport.close();
    const code = await transport.exited;

    // The child died of its own cause — the code proves the signal did not end it.
    expect(code).toBe(23);
    expect(errors).toEqual([]);
    expect(transport.shutdownRequested()).toBe(true);
  });
});
