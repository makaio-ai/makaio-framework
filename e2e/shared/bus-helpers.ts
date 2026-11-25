/**
 * Shared E2E bus test helpers.
 *
 * Thin wrappers around {@link createBusInstance} for common E2E patterns
 * like waiting for full boot completion.
 *
 * Consumed by:
 * - `framework/e2e/desktop/desktop-smoke.test.ts`
 * - `e2e/desktop/desktop-smoke.test.ts`
 */

import { createBusInstance, waitForSubscriptionPropagation } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import type {
  WebSocketClientTransportOptions,
  WebSocketCloseEvent,
  WebSocketLike,
} from '@makaio/bus-transport-websocket';
import { BootSubjects, KernelSubjects } from '@makaio/kernel';
import { UiSubjects, type UiReadyEvent } from '@makaio/ui-kernel';
import { WebSocket } from 'ws';
import type { SpawnedProcess } from './spawn-helpers.js';

/** First close frame observed by a test bus connection. */
export interface TestBusCloseDetails {
  /** WebSocket protocol close code. */
  readonly code: number;
  /** Peer-supplied close reason. */
  readonly reason: string;
}

/**
 * Options for {@link connectTestBus}.
 *
 * A subset of {@link WebSocketClientTransportOptions} forwarded to the
 * underlying transport. The `url` is always provided separately. `onSocketClose`
 * is an E2E-only observer; it does not change the transport's close handling.
 */
export interface ConnectTestBusOptions extends Partial<Omit<WebSocketClientTransportOptions, 'url' | 'autoReconnect'>> {
  /** Observe the first socket close without changing production transport behavior. */
  onSocketClose?: (details: TestBusCloseDetails) => void;
}

/**
 * Attach a one-shot close recorder to an E2E socket.
 * @param socket - Socket created for the test bus transport.
 * @param onSocketClose - Optional diagnostic observer.
 * @returns The unchanged socket for the transport to own.
 */
function recordFirstSocketClose(
  socket: WebSocketLike,
  onSocketClose: ((details: TestBusCloseDetails) => void) | undefined,
): WebSocketLike {
  if (onSocketClose === undefined) return socket;

  let recorded = false;
  socket.addEventListener('close', (event: WebSocketCloseEvent) => {
    if (recorded) return;
    recorded = true;
    onSocketClose({ code: event.code, reason: event.reason });
  });
  return socket;
}

/**
 * Connect a bus client to a test daemon or runtime.
 * @param port - Bus server port
 * @param options - Optional transport overrides
 * @returns Connected bus instance
 */
export async function connectTestBus(port: number, options?: ConnectTestBusOptions): Promise<IMakaioBus> {
  const url = `ws://localhost:${port}/bus`;
  const { onSocketClose, ...transportOptions } = options ?? {};
  console.info('[connectTestBus] Connecting to %s', url);
  const transport = new WebSocketClientTransport({
    ...transportOptions,
    url,
    autoReconnect: false,
    ...(onSocketClose === undefined
      ? {}
      : {
          createWebSocket: async (targetUrl: string): Promise<WebSocketLike> => {
            const socket = await transportOptions.createWebSocket?.(targetUrl);
            return recordFirstSocketClose(socket ?? new WebSocket(targetUrl), onSocketClose);
          },
        }),
  });
  const bus = createBusInstance({ transports: [transport] });
  await bus.connect();
  console.info('[connectTestBus] Connected');
  return bus;
}

/**
 * Boot payload returned by {@link waitForBoot}.
 */
export interface BootPayload {
  /** Total boot duration in milliseconds. */
  totalDurationMs: number;
  /** Names of services that failed to start (may be empty). */
  failedServices: string[];
}

/**
 * Payload returned by {@link waitForRuntimeReady}.
 */
export interface RuntimeReadyPayload {
  /** Whether the runtime is fully initialized. Always `true` when resolved. */
  ready: boolean;
  /** Unique machine identifier assigned by the runtime. */
  machineId: string;
}

/** Payload returned by {@link waitForUiReady}. */
export type UiReadyPayload = UiReadyEvent;

/**
 * Options for {@link raceEventAndProbe}.
 */
interface RaceEventAndProbeOptions {
  /** Maximum wait time in milliseconds. */
  timeoutMs: number;
  /** Label used in log messages (e.g. `'waitForBoot'`). */
  label: string;
}

/**
 * Wait for a readiness event backed by a queryable state.
 *
 * Implements the canonical pattern for waiting on a bus event that may already
 * have fired before the caller connected:
 *
 * 1. Subscribe to the event and wait for subscription propagation.
 * 2. Probe via RPC and return the fast-path result if the condition is already met.
 * 3. Otherwise wait for the event and return the slow-path result.
 * @param subscribe - Installs the event listener and returns its disposer
 * @param probe - Reads the current state
 * @param options - Timeout and logging label
 * @param fastPathCheck - Receives the probe response; return `TPayload` if the
 *   condition is already met, or `null` to fall through to the slow path
 * @returns Resolved payload, either from the fast path or the slow path
 */
async function raceEventAndProbe<TState, TPayload>(
  subscribe: (resolve: (payload: TPayload) => void) => () => void,
  probe: () => Promise<TState>,
  options: RaceEventAndProbeOptions,
  fastPathCheck: (probeResult: TState) => TPayload | null,
): Promise<TPayload> {
  const { timeoutMs, label } = options;
  const t0 = Date.now();
  console.info('[%s] Subscribing to event (timeout=%dms)', label, timeoutMs);

  const event = Promise.withResolvers<TPayload>();
  const unsubscribe = subscribe(event.resolve);
  const deadline = Promise.withResolvers<never>();
  const timer = timeoutMs
    ? setTimeout(
        () => deadline.reject(new Error(`[${label}] Timed out after ${timeoutMs}ms waiting for the event`)),
        timeoutMs,
      )
    : undefined;
  try {
    // Completion before admission is visible in the state; later completion can reach the listener.
    await Promise.race([waitForSubscriptionPropagation(unsubscribe), deadline.promise]);
    const state = Promise.resolve()
      .then(probe)
      .catch((err: unknown) => {
        const errName = err instanceof Error ? err.constructor.name : err === null ? 'null' : typeof err;
        console.info('[%s] probe not available (%s), waiting for event (waited=%dms)', label, errName, Date.now() - t0);
        return null;
      });
    const probeResult = await Promise.race([state, deadline.promise]);

    if (probeResult !== null) {
      const fastResult = fastPathCheck(probeResult);
      if (fastResult !== null) {
        console.info('[%s] Fast-path: condition already met (waited=%dms)', label, Date.now() - t0);
        return fastResult;
      }
      console.info('[%s] probe returned not-ready, waiting for event (waited=%dms)', label, Date.now() - t0);
    }

    const result = await Promise.race([event.promise, deadline.promise]);
    console.info('[%s] event received (waited=%dms)', label, Date.now() - t0);
    return result;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

/**
 * Wait for full boot completion using the race-safe probe pattern.
 *
 * Waits for the `boot.complete` subscription to propagate, then checks
 * `boot.getState` for completion during or before subscription admission.
 * @param bus - Connected bus instance
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns Boot payload containing duration and any failed services
 */
export async function waitForBoot(bus: IMakaioBus, timeoutMs = 30_000): Promise<BootPayload> {
  return raceEventAndProbe(
    (resolve: (payload: BootPayload) => void) => bus.on(BootSubjects.complete, ({ payload }) => resolve(payload)),
    () => bus.request(bus.own('root'), BootSubjects.getState, {}, { timeout: timeoutMs }),
    { timeoutMs, label: 'waitForBoot' },
    (state) =>
      state.complete ? { totalDurationMs: state.totalDurationMs ?? 0, failedServices: state.failedServices } : null,
  );
}

/**
 * Wait for the kernel to be fully initialized using the race-safe probe pattern.
 *
 * Waits for the `kernel.ready` subscription to propagate, then probes
 * `kernel.isReady`. When the probe returns `ready=true`, the listener is
 * discarded. Otherwise the function awaits the event before returning.
 * @param bus - Connected bus instance
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns Runtime ready payload containing `ready` flag and `machineId`
 */
export async function waitForRuntimeReady(bus: IMakaioBus, timeoutMs = 30_000): Promise<RuntimeReadyPayload> {
  return raceEventAndProbe(
    (resolve: (payload: RuntimeReadyPayload) => void) =>
      bus.on(KernelSubjects.ready, ({ payload }) => resolve({ ready: true, machineId: payload.machineId })),
    () => bus.request(bus.own('root'), KernelSubjects.isReady, {}, { timeout: timeoutMs }),
    { timeoutMs, label: 'waitForRuntimeReady' },
    (probeResult) => (probeResult.ready ? { ready: true, machineId: probeResult.machineId } : null),
  );
}

/**
 * Wait for a renderer surface to mount its shared React application.
 *
 * Unlike boot and kernel readiness there is no stable UI-ready probe: this is a
 * renderer-originated lifecycle event, so callers must subscribe before the
 * window is expected to finish loading.
 * @param bus - Connected bus instance
 * @param surface - Renderer surface expected to emit `ui.ready`
 * @param host - Host whose exit ends the pending renderer wait
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns UI ready payload emitted by the renderer
 */
export function waitForUiReady(
  bus: IMakaioBus,
  surface: UiReadyEvent['surface'],
  host: Pick<SpawnedProcess, 'waitForExit'>,
  timeoutMs = 30_000,
): Promise<UiReadyPayload> {
  const wait = (async () => {
    const abort = new AbortController();
    try {
      const uiReady = bus
        .once(UiSubjects.ready, { filter: { surface }, timeoutMs, signal: abort.signal })
        .then((ctx) => ({ kind: 'ready' as const, payload: ctx.payload }));
      const hostExit = host.waitForExit().then((exit) => ({ kind: 'exit' as const, exit }));
      const result = await Promise.race([uiReady, hostExit]);
      if (result.kind === 'exit') {
        throw new Error(
          `[waitForUiReady] Host exited before ui.ready for ${surface} (code=${String(result.exit.code)}, signal=${String(result.exit.signal)})`,
        );
      }
      return result.payload;
    } finally {
      abort.abort();
    }
  })();
  // Smoke tests subscribe early but await UI readiness after other boot assertions.
  // Observe this original promise now without changing what its later consumer receives.
  void wait.catch(() => undefined);
  return wait;
}
