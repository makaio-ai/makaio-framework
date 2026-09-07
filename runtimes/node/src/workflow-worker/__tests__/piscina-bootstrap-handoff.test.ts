import { getEventListeners } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { acceptPiscinaBootstrapHandoff, dispatchWithBootstrapHandoff } from '../piscina-bootstrap-handoff.js';

/**
 * Produce one original timestamp, without resetting it during the protocol.
 * @param milliseconds - Remaining bootstrap budget.
 * @returns Absolute deadline.
 */
function deadline(milliseconds = 2000): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

describe('Piscina bootstrap ownership handoff', () => {
  it('disarms the host bound after ACK while retaining caller cancellation', async () => {
    const controller = new AbortController();
    const ready = Promise.withResolvers<AbortSignal>();
    const finish = Promise.withResolvers<string>();
    const timestamp = deadline();
    const run = dispatchWithBootstrapHandoff(timestamp, controller.signal, async (port, signal) => {
      await acceptPiscinaBootstrapHandoff({ bootstrapPort: port, bootstrapDeadlineAt: timestamp });
      ready.resolve(signal);
      return finish.promise;
    });
    const taskSignal = await ready.promise;
    await delay(Math.max(0, Date.parse(timestamp) - Date.now()) + 10);
    expect(taskSignal.aborted).toBe(false);
    controller.abort(new Error('caller stopped'));
    expect(taskSignal.reason).toBe(controller.signal.reason);
    finish.resolve('finished');
    await expect(run).resolves.toBe('finished');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('cleans transferred endpoints and listeners after a successful handshake', async () => {
    const controller = new AbortController();
    const timestamp = deadline();
    let workerPort: MessageChannel['port2'] | undefined;
    await expect(
      dispatchWithBootstrapHandoff(timestamp, controller.signal, async (port) => {
        workerPort = port;
        await acceptPiscinaBootstrapHandoff({ bootstrapPort: port, bootstrapDeadlineAt: timestamp });
        return 'done';
      }),
    ).resolves.toBe('done');
    expect(workerPort?.listenerCount('message')).toBe(0);
    expect(workerPort?.listenerCount('messageerror')).toBe(0);
    expect(workerPort?.listenerCount('close')).toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['completed', 'failed'] as const)('settles promptly when a task %s before handoff', async (mode) => {
    const controller = new AbortController();
    const failure = new Error('task failed');
    const run = dispatchWithBootstrapHandoff(deadline(), controller.signal, async () => {
      if (mode === 'failed') throw failure;
      return 'early';
    });
    if (mode === 'failed') await expect(run).rejects.toBe(failure);
    else await expect(run).rejects.toThrow('completed before bootstrap handoff');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['malformed', 'closed'] as const)('aborts the dispatched task on a %s handoff port', async (mode) => {
    const dispatched = Promise.withResolvers<AbortSignal>();
    const run = dispatchWithBootstrapHandoff(deadline(), new AbortController().signal, async (port, signal) => {
      dispatched.resolve(signal);
      if (mode === 'malformed') port.postMessage({ status: 'unexpected' });
      else port.close();
      return new Promise<never>(() => {});
    });
    const taskSignal = await dispatched.promise;
    await expect(run).rejects.toThrow(mode === 'closed' ? 'port closed' : 'Invalid Piscina');
    expect(taskSignal.aborted).toBe(true);
  });

  it.each(['abort', 'expiry'] as const)('does not permit work when the host withholds ACK until %s', async (mode) => {
    const channel = new MessageChannel();
    const controller = new AbortController();
    const requested = Promise.withResolvers<void>();
    channel.port1.once('message', () => requested.resolve());
    const accepted = acceptPiscinaBootstrapHandoff(
      {
        bootstrapPort: channel.port2,
        bootstrapDeadlineAt: deadline(mode === 'expiry' ? 50 : 2000),
      },
      controller.signal,
    );
    const rejection = expect(accepted).rejects.toThrow(mode === 'expiry' ? 'deadline exceeded' : 'caller stopped');
    try {
      await requested.promise;
      if (mode === 'abort') controller.abort(new Error('caller stopped'));
      await rejection;
      channel.port1.postMessage('acknowledged');
      expect(channel.port2.listenerCount('message')).toBe(0);
      expect(channel.port2.listenerCount('close')).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it.each(['malformed', 'closed'] as const)('rejects the worker side when its host endpoint is %s', async (mode) => {
    const channel = new MessageChannel();
    channel.port1.once('message', () => {
      if (mode === 'malformed') channel.port1.postMessage('not-an-ack');
      else channel.port1.close();
    });
    try {
      await expect(
        acceptPiscinaBootstrapHandoff({
          bootstrapPort: channel.port2,
          bootstrapDeadlineAt: deadline(),
        }),
      ).rejects.toThrow(mode === 'closed' ? 'port closed' : 'Invalid Piscina');
      expect(channel.port2.listenerCount('message')).toBe(0);
      expect(channel.port2.listenerCount('messageerror')).toBe(0);
      expect(channel.port2.listenerCount('close')).toBe(0);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('propagates caller cancellation while the host still awaits takeover', async () => {
    const caller = new AbortController();
    const dispatched = Promise.withResolvers<AbortSignal>();
    const run = dispatchWithBootstrapHandoff(deadline(), caller.signal, async (_port, signal) => {
      dispatched.resolve(signal);
      return new Promise<never>(() => {});
    });
    const rejection = expect(run).rejects.toThrow('cancel during handoff');
    const taskSignal = await dispatched.promise;
    caller.abort(new Error('cancel during handoff'));
    await rejection;
    expect(taskSignal.reason).toBe(caller.signal.reason);
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
  });

  it('rejects pre-cancellation without dispatching', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    let dispatched = false;
    await expect(
      dispatchWithBootstrapHandoff(deadline(), controller.signal, async () => {
        dispatched = true;
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(dispatched).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
