import { createBusInstance, getFullSubjectForSubjectDefinition } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import { BootNamespace, BootSubjects } from '@makaio/kernel';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { waitForBoot } from '../../../e2e/shared/bus-helpers.js';
import { startBootHost } from './boot-wait.test-support.js';

const timeoutMs = 1000;

/**
 * Connect a real client and host while holding the completion subscription at the boundary.
 * @param cleanup - Registers teardown for this test.
 * @returns Boot controls and call-through observers for the wire operations.
 */
async function connect(cleanup: (fn: () => Promise<void>) => void) {
  const host = await startBootHost(cleanup);
  const transport = new WebSocketClientTransport({
    url: host.url,
    autoReconnect: false,
    createWebSocket: (url) => new WebSocket(url),
  });
  const client = createBusInstance({ transports: [transport] });
  client.registerNamespace(BootNamespace);
  cleanup(async () => client.disconnect());
  await client.connect();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const subscriptions = vi.spyOn(transport, 'subscribe');
  const probes = vi.spyOn(client, 'request');

  return { ...host, client, transport, subscriptions, probes };
}

it('reads completed boot state when the event occurred during subscription admission', async ({ onTestFinished }) => {
  const { boot, client, admit, admissionStarted, sends, subscriptions, probes } = await connect(onTestFinished);
  const result = waitForBoot(client, timeoutMs).catch((error: unknown) => error);

  await admissionStarted;
  // The old waiter has already sent its only probe. Let its actual RPC finish before boot.
  const earlyProbe = probes.mock.results[0];
  if (earlyProbe !== undefined) {
    await expect(earlyProbe.value).resolves.toMatchObject({ complete: false });
  }
  boot.complete();
  const sendIndex = sends.mock.calls.findIndex(([message]) => message.type === 'event');
  await expect(sends.mock.results[sendIndex]?.value).resolves.toBe(false);

  admit.resolve();
  await expect(subscriptions.mock.results[0]?.value).resolves.toBeUndefined();
  // Drain the acknowledgement continuations, then let the state RPC finish on the real socket.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await probes.mock.results[0]?.value;
  await vi.advanceTimersByTimeAsync(timeoutMs);
  expect(await result).toEqual({ totalDurationMs: expect.any(Number), failedServices: [] });
  expect(earlyProbe).toBeUndefined();
});

it('receives the completion event when boot finishes after the admitted waiter reads incomplete state', async ({
  onTestFinished,
}) => {
  const { boot, client, admit, admissionStarted, sends, subscriptions, probes } = await connect(onTestFinished);
  const result = waitForBoot(client, timeoutMs);
  const expected = expect(result).resolves.toEqual({ totalDurationMs: expect.any(Number), failedServices: [] });

  await admissionStarted;
  admit.resolve();
  await expect(subscriptions.mock.results[0]?.value).resolves.toBeUndefined();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect(probes.mock.results[0]?.value).resolves.toMatchObject({ complete: false });
  boot.complete();
  const sendIndex = sends.mock.calls.findIndex(([message]) => message.type === 'event');
  await expect(sends.mock.results[sendIndex]?.value).resolves.toBe(true);
  await expected;
});

it('times out and removes the listener when subscription admission never settles', async ({ onTestFinished }) => {
  const { client, transport, admissionStarted, stateRequests } = await connect(onTestFinished);
  const unsubscribe = vi.spyOn(transport, 'unsubscribe');
  const result = waitForBoot(client, timeoutMs).catch((error: unknown) => error);

  await admissionStarted;
  await vi.advanceTimersByTimeAsync(timeoutMs);

  expect(unsubscribe).toHaveBeenCalledExactlyOnceWith(getFullSubjectForSubjectDefinition(BootSubjects.complete));
  expect(stateRequests).not.toHaveBeenCalled();
  expect(await result).toEqual(new Error('[waitForBoot] Timed out after 1000ms waiting for the event'));
});
