import { describe, expect, it } from 'vitest';
import { createMockBus } from './bus-test-harness.js';

function createSentinel(): Promise<'sentinel'> {
  return new Promise<'sentinel'>((resolve) => setTimeout(resolve, 10, 'sentinel'));
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  expect(await Promise.race([promise.then(() => 'ready' as const), createSentinel()])).toBe('sentinel');
}

describe('createMockBus', () => {
  it('keeps bus.ready pending until setReady() resolves it', async () => {
    const { bus, setReady } = createMockBus();

    await expectPending(bus.ready);

    setReady();

    await expect(bus.ready).resolves.toBeUndefined();
    await expect(bus.connect()).resolves.toBeUndefined();
  });

  it('resets bus.ready to pending after disconnect()', async () => {
    const { bus, setReady } = createMockBus();

    setReady();
    await expect(bus.ready).resolves.toBeUndefined();

    bus.disconnect();

    await expectPending(bus.ready);
  });

  it('settles an in-flight connect() when disconnect() is called', async () => {
    const { bus } = createMockBus();

    const connectPromise = bus.connect().then(() => 'connected' as const);
    expect(await Promise.race([connectPromise, createSentinel()])).toBe('sentinel');

    bus.disconnect();

    await expect(connectPromise).resolves.toBe('connected');
  });

  it('does not let setReady() override an externally provided ready promise', async () => {
    const { bus, setReady } = createMockBus();
    let resolveExternal!: () => void;
    const externalReady = new Promise<void>((resolve) => {
      resolveExternal = resolve;
    });

    const previousReady = bus.ready;
    setReady(externalReady);

    await expect(previousReady).resolves.toBeUndefined();

    await expectPending(bus.ready);

    setReady();
    await expectPending(bus.ready);

    resolveExternal();

    await expect(bus.ready).resolves.toBeUndefined();
  });
});
