// @vitest-environment jsdom
import { MakaioBus, waitForSubscriptionPropagation } from '@makaio/bus-core';
import { BootSubjects } from '@makaio/kernel';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { bootstrapRenderer } from '../src/renderer/bootstrap.js';
import { startBootHost } from './boot-wait.test-support.js';

const { render } = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render, unmount: () => undefined }),
}));

vi.mock('@makaio/preferences/browser', () => ({
  registerBrowserPreferencesStorage: () => () => undefined,
}));

vi.mock('@makaio/ui-hooks', () => ({
  useWindowContext: { getState: () => ({ setWindowId: () => undefined }) },
}));

vi.mock('../src/renderer/App.js', () => ({
  App: () => null,
  resetReadySurface: () => undefined,
}));

afterEach(() => {
  window.dispatchEvent(new Event('unload'));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  render.mockClear();
});

/**
 * Launch the renderer with its own bus and transport against a gated startup host.
 * @param cleanup - Registers teardown for the boot host.
 * @returns Host controls and the in-flight renderer bootstrap.
 */
async function launchRenderer(cleanup: (fn: () => Promise<void>) => void) {
  document.body.innerHTML = '<div id="loading-label"></div><div id="root"></div>';
  const host = await startBootHost(cleanup);
  const openSocket = Promise.withResolvers<WebSocket>();
  vi.stubGlobal(
    'WebSocket',
    class extends WebSocket {
      public constructor(url: string) {
        super(url);
        openSocket.resolve(this);
      }
    },
  );
  const warn = vi.spyOn(console, 'warn');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const result = bootstrapRenderer({
    config: { busUrl: host.url, bootComplete: false, projectId: null, windowId: null },
    logPrefix: 'renderer',
    surface: 'electron',
  });

  return { ...host, result, socket: openSocket.promise, warn };
}

/**
 * Observe splash progress driven by the renderer's state response.
 * @param cleanup - Registers teardown for the observer.
 * @returns Promise that resolves upon displaying the incomplete state.
 */
function observeIncompleteState(cleanup: (fn: () => void) => void): Promise<void> {
  const shown = Promise.withResolvers<void>();
  const label = document.getElementById('loading-label')!;
  const observer = new MutationObserver(() => {
    if (label.textContent === 'Loading services... (0/1)') shown.resolve();
  });
  observer.observe(label, { childList: true });
  cleanup(() => observer.disconnect());
  return shown.promise;
}

it('mounts from completed state when boot ends during subscription admission', async ({ onTestFinished }) => {
  const { boot, admit, admissionStarted, result, sends, socket, stateRequests, warn } =
    await launchRenderer(onTestFinished);

  await admissionStarted;
  const peer = await socket;
  const pong = Promise.withResolvers<void>();
  // The host counts requests synchronously on receipt. The pong fences those earlier frames.
  peer.once('pong', () => pong.resolve());
  peer.ping();
  await pong.promise;
  expect(stateRequests).not.toHaveBeenCalled();

  boot.complete();
  const sendIndex = sends.mock.calls.findIndex(([message]) => message.type === 'event');
  await expect(sends.mock.results[sendIndex]?.value).resolves.toBe(false);
  expect(render).not.toHaveBeenCalled();
  admit.resolve();
  await result;
  expect(stateRequests).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(warn).not.toHaveBeenCalledWith('[renderer] Boot timeout - mounting React');
});

it('mounts from the completion event after reading incomplete startup state', async ({ onTestFinished }) => {
  const { boot, admit, admissionStarted, result, stateRequests, warn } = await launchRenderer(onTestFinished);

  await admissionStarted;
  const incompleteState = observeIncompleteState(onTestFinished);
  admit.resolve();
  await incompleteState;
  expect(render).not.toHaveBeenCalled();

  boot.complete();
  await result;
  expect(stateRequests).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(warn).not.toHaveBeenCalledWith('[renderer] Boot timeout - mounting React');
});

it('ends the boot wait on unload while admission is pending', async ({ onTestFinished }) => {
  const on = vi.spyOn(MakaioBus, 'on');
  const request = vi.spyOn(MakaioBus, 'request');
  const { admit, admissionStarted, result, stateRequests, warn } = await launchRenderer(onTestFinished);

  await admissionStarted;
  const completeListener = on.mock.calls.findIndex(([subject]) => subject === BootSubjects.complete);
  expect(completeListener).toBeGreaterThanOrEqual(0);

  // Unload aborts the renderer bootstrap and closes the real transport.
  window.dispatchEvent(new Event('unload'));
  await result;
  admit.resolve();
  await waitForSubscriptionPropagation(on.mock.results[completeListener]?.value);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(request).not.toHaveBeenCalled();
  expect(stateRequests).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalledWith('[renderer] Boot timeout - mounting React');
});
