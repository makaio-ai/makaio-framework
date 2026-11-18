/**
 * Contract of {@link createGatedClose} that real drivers cannot show: what a
 * close that fails leaves behind.
 *
 * The drivers' own close does not fail on demand, so the closer is a function
 * the test controls; the gate is the real one.
 */
import { describe, expect, it } from 'vitest';
import { createGatedClose } from '../engine/sqlite/gated-close';
import { HandleGate } from '../engine/sqlite/handle-gate';

describe('createGatedClose', () => {
  it('lets a close that failed synchronously be retried instead of reporting success', () => {
    let attempts = 0;
    const close = createGatedClose(new HandleGate(), () => {
      attempts += 1;
      if (attempts === 1) throw new Error('release failed');
    });

    expect(() => close()).toThrow('release failed');
    expect(close()).toBeUndefined();
    expect(attempts).toBe(2);
    // Once closed, further calls do not close again.
    close();
    expect(attempts).toBe(2);
  });

  it('lets a close that failed while waiting for the holder be retried', async () => {
    const gate = new HandleGate();
    const release = Promise.withResolvers<void>();
    let attempts = 0;
    const closeConnection = (): void => {
      attempts += 1;
      if (attempts === 1) throw new Error('release failed');
    };
    const close = createGatedClose(gate, closeConnection);
    const holder = gate.exclusive(async () => release.promise);

    const first = close();
    release.resolve();
    await holder;
    await expect(first).rejects.toThrow('release failed');

    await expect(Promise.resolve(close())).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('returns the first close result to repeated calls while that close is pending', async () => {
    const gate = new HandleGate();
    const release = Promise.withResolvers<void>();
    const close = createGatedClose(gate, () => undefined);
    const holder = gate.exclusive(async () => release.promise);

    const first = close();
    expect(close()).toBe(first);
    release.resolve();
    await holder;
    await first;
  });
});
