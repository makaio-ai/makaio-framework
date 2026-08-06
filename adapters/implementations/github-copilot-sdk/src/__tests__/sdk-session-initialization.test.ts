import { describe, expect, it, vi } from 'vitest';
import { initializeCopilotSdkSession } from '../sdk-session-initialization.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('initializeCopilotSdkSession', () => {
  it('does not create a session when shutdown begins during client startup', async () => {
    const startGate = deferred();
    let closing = false;
    const createSession = vi.fn();
    const client = { start: async () => await startGate.promise, createSession };
    const initialization = initializeCopilotSdkSession({ client, sessionConfig: {}, isClosing: () => closing });

    closing = true;
    startGate.resolve();

    await expect(initialization).rejects.toThrow('initialization was cancelled');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('destroys a session created after shutdown begins', async () => {
    const createGate = deferred();
    let closing = false;
    const destroy = vi.fn().mockResolvedValue(undefined);
    const client = {
      start: async () => undefined,
      createSession: vi.fn(async () => {
        await createGate.promise;
        return { destroy };
      }),
    };
    const initialization = initializeCopilotSdkSession({ client, sessionConfig: {}, isClosing: () => closing });

    await vi.waitFor(() => expect(client.createSession).toHaveBeenCalledTimes(1));
    closing = true;
    createGate.resolve();

    await expect(initialization).rejects.toThrow('initialization was cancelled');
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
