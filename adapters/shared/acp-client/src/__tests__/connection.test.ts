import { describe, expect, it } from 'vitest';
import { createAcpConnection } from '../connection.js';

describe('createAcpConnection', () => {
  it('rejects immediately when the subprocess cannot be spawned', async () => {
    await expect(
      createAcpConnection(
        () => ({
          sessionUpdate: async () => {},
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        }),
        {
          command: '/definitely/missing/binary',
          args: [],
          cwd: process.cwd(),
          env: { ...process.env } as Record<string, string>,
          spawnTimeoutMs: 10_000,
        },
      ),
    ).rejects.toThrow();
  });

  it('settles the exit observation of an agent that ends as soon as it starts', async () => {
    // The contract, against a real child that is gone almost at once: a retirement
    // awaits this promise as its exit evidence, so an unsettled one costs the whole
    // observation budget and then reports an unobserved end for a process that died
    // immediately. Node delivers such an exit at least one turn after the spawn
    // event, so this arm pins the contract rather than the ordering — the
    // same-turn arm in `connection.cleanup.test.ts` pins that.
    const handle = await createAcpConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      }),
      {
        command: process.execPath,
        args: ['-e', 'process.exit(7)'],
        cwd: process.cwd(),
        env: { ...process.env } as Record<string, string>,
        spawnTimeoutMs: 10_000,
      },
    );

    await expect(handle.exited).resolves.toBe(7);
  });
});
