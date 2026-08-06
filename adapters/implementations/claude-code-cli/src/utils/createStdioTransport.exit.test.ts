/**
 * The CLI transport's exit observation, against a real spawned child.
 *
 * A stub cannot show what was missing here. The exit was always *observed* — a
 * listener branched on the code — but a caller that asked for the close had
 * nothing to await, so "the close returned" was the only fact it could report.
 * These tests spawn a real process and assert the awaitable observation exists
 * and is coupled to the close.
 */

import { describe, expect, it } from 'vitest';

import { createStdioTransport } from './createStdioTransport.js';

/** Spawning `node -e <script>` gives a real child whose lifetime the test controls. */
const NODE_BINARY = process.execPath;

describe('CliStdioTransport exit observation', () => {
  it('settles the exit promise with the code a self-terminating child reports', async () => {
    const transport = createStdioTransport(['-e', 'process.exit(0)'], process.cwd(), {}, NODE_BINARY);

    await expect(transport.exited).resolves.toBe(0);
  });

  it('settles the exit promise with a non-zero code', async () => {
    const transport = createStdioTransport(['-e', 'process.exit(17)'], process.cwd(), {}, NODE_BINARY);

    await expect(transport.exited).resolves.toBe(17);
  });

  it('couples close() to the observation, so a requested close can be awaited', async () => {
    // A child that would outlive the test unless it is killed: if `close()` were
    // not coupled to an observable end, this await could never settle.
    const transport = createStdioTransport(['-e', 'setInterval(() => {}, 1000)'], process.cwd(), {}, NODE_BINARY);

    transport.close();

    // `null` is the signalled-termination code, which is what a kill produces.
    await expect(transport.exited).resolves.toBeNull();
  });

  it('settles for a binary that never ran, so a retirement cannot wait on nothing', async () => {
    // The edge an `exit`-only observation cannot reach: a missing binary emits
    // `error` and `close` and no `exit` at all. A promise that never settles costs
    // the caller its entire observation budget and then reports an unobserved end
    // for a process that never existed, so the transport answers from `close`.
    const transport = createStdioTransport([], process.cwd(), {}, '/definitely/missing/claude-binary');

    // `null` is "ended without a code", the same fact a signalled termination
    // reports — the promise answers whether it is over, never why.
    await expect(transport.exited).resolves.toBeNull();
  });

  it('resolves the same observation for every awaiter', async () => {
    const transport = createStdioTransport(['-e', 'process.exit(5)'], process.cwd(), {}, NODE_BINARY);

    const [first, second] = await Promise.all([transport.exited, transport.exited]);

    expect(first).toBe(5);
    expect(second).toBe(5);
  });
});
