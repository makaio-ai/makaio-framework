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

import { createBusInstance, OnceAbortError } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import type { WebSocketClientTransportOptions } from '@makaio/bus-transport-websocket';
import { BootSubjects, KernelSubjects } from '@makaio/kernel';
import { UiSubjects, type UiReadyEvent } from '@makaio/ui-kernel';
import type { ContextForSubjectDefinition, ExtractSubjectResponse, SubjectDefinition } from '@makaio/core';

/**
 * Options for {@link connectTestBus}.
 *
 * A subset of {@link WebSocketClientTransportOptions} forwarded to the
 * underlying transport. The `url` is always provided separately.
 */
export type ConnectTestBusOptions = Partial<Omit<WebSocketClientTransportOptions, 'url' | 'autoReconnect'>>;

/**
 * Connect a bus client to a test daemon or runtime.
 * @param port - Bus server port
 * @param options - Optional transport overrides
 * @returns Connected bus instance
 */
export async function connectTestBus(port: number, options?: ConnectTestBusOptions): Promise<IMakaioBus> {
  const url = `ws://localhost:${port}/bus`;
  console.info('[connectTestBus] Connecting to %s', url);
  const transport = new WebSocketClientTransport({
    ...options,
    url,
    autoReconnect: false,
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
 * A non-request, non-channel subject definition — safe for use as an event subject
 * in {@link raceEventAndProbe}.
 */
type EventSubjectDefinition = SubjectDefinition & { $meta: { isRequest: false; channel: false } };

/**
 * A request, non-channel subject definition — safe for use as a probe subject
 * in {@link raceEventAndProbe}.
 */
type RequestSubjectDefinition = SubjectDefinition & { $meta: { isRequest: true; channel: false } };

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
 * Race-safe subscribe / probe / abort helper.
 *
 * Implements the canonical pattern for waiting on a bus event that may already
 * have fired before the caller connected:
 *
 * 1. Subscribe to `eventSubject` first (prevents the race).
 * 2. Probe `probeSubject` via RPC; if the probe indicates the condition is already
 *    met, abort the pending listener and return the fast-path result immediately.
 * 3. Otherwise wait for the event and return the slow-path result.
 * @param bus - Connected bus instance
 * @param eventSubject - Subject to listen on for the slow path
 * @param probeSubject - Request subject to probe for the fast path
 * @param probePayload - Payload forwarded to the probe request
 * @param options - Timeout and logging label
 * @param fastPathCheck - Receives the probe response; return `TPayload` if the
 *   condition is already met, or `null` to fall through to the slow path
 * @param slowPathExtract - Receives the event context; extracts and returns `TPayload`
 * @returns Resolved payload, either from the fast path or the slow path
 */
async function raceEventAndProbe<
  TEventSubject extends EventSubjectDefinition,
  TProbeSubject extends RequestSubjectDefinition,
  TPayload,
>(
  bus: IMakaioBus,
  eventSubject: TEventSubject,
  probeSubject: TProbeSubject,
  probePayload: TProbeSubject['$meta']['payload']['request'],
  options: RaceEventAndProbeOptions,
  fastPathCheck: (probeResult: ExtractSubjectResponse<TProbeSubject>) => TPayload | null,
  slowPathExtract: (eventCtx: ContextForSubjectDefinition<TEventSubject>) => TPayload,
): Promise<TPayload> {
  const { timeoutMs, label } = options;
  const abort = new AbortController();
  const t0 = Date.now();
  console.info('[%s] Subscribing to event (timeout=%dms)', label, timeoutMs);

  // Subscribe FIRST to prevent a race where the event fires between the probe
  // request and the listener registration.
  // The double-cast is required because IMakaioBus.once() constrains its Subject
  // generic to the bus's own Subjects type variable, which is not visible from
  // an external generic helper. Fixing this properly requires a looser overload
  // on the IMakaioBus interface.
  const eventPromise = (
    bus.once(eventSubject as never, { timeoutMs, signal: abort.signal } as never) as unknown as Promise<
      ContextForSubjectDefinition<TEventSubject>
    >
  ).catch((error: unknown) => {
    if (abort.signal.aborted && error instanceof OnceAbortError) {
      return null;
    }
    throw error;
  });

  // Probe to check whether the condition is already satisfied.
  let probeResult: ExtractSubjectResponse<TProbeSubject> | null = null;
  try {
    probeResult = (await bus.request(probeSubject as never, probePayload as never, {
      timeout: timeoutMs,
    })) as ExtractSubjectResponse<TProbeSubject>;
  } catch (err: unknown) {
    const errName = err instanceof Error ? err.constructor.name : err === null ? 'null' : typeof err;
    console.info('[%s] probe not available (%s), waiting for event (waited=%dms)', label, errName, Date.now() - t0);
  }

  if (probeResult !== null) {
    const fastResult = fastPathCheck(probeResult);
    if (fastResult !== null) {
      // Fast path: condition already met — discard the pending listener.
      abort.abort();
      void eventPromise;
      console.info('[%s] Fast-path: condition already met (waited=%dms)', label, Date.now() - t0);
      return fastResult;
    }
    console.info('[%s] probe returned not-ready, waiting for event (waited=%dms)', label, Date.now() - t0);
  }

  // Slow path: wait for the event.
  const eventCtx = await eventPromise;
  if (eventCtx === null) {
    throw new Error(`[${label}] Event wait was aborted before the slow path completed`);
  }
  const result = slowPathExtract(eventCtx);
  console.info('[%s] event received (waited=%dms)', label, Date.now() - t0);
  return result;
}

/**
 * Wait for full boot completion using the race-safe probe pattern.
 *
 * Subscribes to the `boot.complete` event first, then checks
 * `boot.getState` in case boot already finished before the
 * listener was registered. Resolves immediately if boot is already done.
 * @param bus - Connected bus instance
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns Boot payload containing duration and any failed services
 */
export async function waitForBoot(bus: IMakaioBus, timeoutMs = 30_000): Promise<BootPayload> {
  return raceEventAndProbe(
    bus,
    BootSubjects.complete,
    BootSubjects.getState,
    {},
    { timeoutMs, label: 'waitForBoot' },
    (state) =>
      state.complete ? { totalDurationMs: state.totalDurationMs ?? 0, failedServices: state.failedServices } : null,
    (ctx) => ({
      totalDurationMs: ctx.payload.totalDurationMs,
      failedServices: ctx.payload.failedServices,
    }),
  );
}

/**
 * Wait for the kernel to be fully initialized using the race-safe probe pattern.
 *
 * Subscribes to the `kernel.ready` event first, then probes `kernel.isReady`
 * via RPC. If the event already fired before the listener was registered, the
 * probe returns `ready=true` and the pending listener is discarded. Otherwise
 * the function awaits the event before returning.
 * @param bus - Connected bus instance
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns Runtime ready payload containing `ready` flag and `machineId`
 */
export async function waitForRuntimeReady(bus: IMakaioBus, timeoutMs = 30_000): Promise<RuntimeReadyPayload> {
  return raceEventAndProbe(
    bus,
    KernelSubjects.ready,
    KernelSubjects.isReady,
    {},
    { timeoutMs, label: 'waitForRuntimeReady' },
    (probeResult) => (probeResult.ready ? { ready: true, machineId: probeResult.machineId } : null),
    (ctx) => ({ ready: true, machineId: ctx.payload.machineId }),
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
 * @param timeoutMs - Maximum wait time in milliseconds
 * @returns UI ready payload emitted by the renderer
 */
export async function waitForUiReady(
  bus: IMakaioBus,
  surface: UiReadyEvent['surface'],
  timeoutMs = 30_000,
): Promise<UiReadyPayload> {
  const ctx = await bus.once(UiSubjects.ready, { filter: { surface }, timeoutMs });
  return ctx.payload;
}
