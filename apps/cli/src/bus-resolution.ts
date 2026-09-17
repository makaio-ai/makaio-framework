/**
 * Resolution of the single bus instance used for one CLI invocation.
 *
 * Extracted from `main.ts` so the orchestration module stays within its line
 * budget. Two paths lead here and both must end in the same downstream state:
 * - the normal path — probe `/health`, optionally launch the desktop app, then
 *   open the WebSocket connection;
 * - the built-in hook failure cool-down — skip probe and connect entirely and
 *   report "no bus" immediately (see `builtin-hook-debounce.ts`).
 *
 * Because the two are indistinguishable downstream, Commander still parses and
 * validates argv either way, and command actions still see the documented
 * `null`-bus behaviour.
 * @packageDocumentation
 */
import type { IMakaioBus } from '@makaio/bus-core';
import { connectBusClient, isAuthConnectionError, probeHealth, resolveClientAuth } from './bus-client.js';
import type { ServerHealth } from './bus-client.js';
import { launchAppAndWaitForBus } from './app-launch.js';
import { shouldSkipBusProbe } from './builtin-hook-debounce.js';

/**
 * Connect the single bus instance for the CLI invocation.
 *
 * Returns `null` when the server is unreachable — commands still register for
 * `--help` visibility but actions fail with the best available connection
 * context.
 * Always uses `autoReconnect: true` so interactive TUI sessions survive
 * transient disconnections. For one-shot subcommands this is harmless because
 * `disconnect()` aborts the reconnect loop before any retry fires.
 * @param health - Health probe result, or `null` when the server is unreachable.
 * @param options - Connection logging behavior for the current invocation.
 * @returns Connected bus instance (or `null`) and a human-readable error when
 *   the connection failed.
 */
async function connectCliBus(
  health: ServerHealth | null,
  options?: { readonly backgroundLaunchAttempted?: boolean; readonly suppressConnectionWarnings?: boolean },
): Promise<{ bus: IMakaioBus | null; connectionError?: string; connectionFailure?: 'auth' | 'transport' }> {
  if (!health) {
    const connectionError = options?.backgroundLaunchAttempted
      ? 'Makaio server did not become reachable after starting the desktop app in background mode.'
      : 'Makaio server is not reachable.\nStart it with: makaio serve';
    return { bus: null, connectionError };
  }

  try {
    const auth = resolveClientAuth(health);
    const bus = await connectBusClient(undefined, { auth, autoReconnect: true });
    return { bus };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAuthConnectionError(err)) {
      if (!options?.suppressConnectionWarnings) {
        console.warn('[cli] Bus connection failed:', message);
      }
      return { bus: null, connectionError: `Bus authentication failed: ${message}`, connectionFailure: 'auth' };
    }
    if (!options?.suppressConnectionWarnings) {
      console.warn('[cli] Could not connect to server:', message);
    }
    return {
      bus: null,
      connectionError: `Could not connect to Makaio server: ${message}`,
      connectionFailure: 'transport',
    };
  }
}

interface CliHealthProbeResult {
  /** Health probe result after optional background launch. */
  readonly health: ServerHealth | null;
  /** Whether the CLI attempted to launch the desktop app before returning. */
  readonly backgroundLaunchAttempted: boolean;
}

/**
 * Probe the bus health endpoint and attempt background desktop launch only
 * when the initial probe fails and the targeted command cannot provide its
 * own embedded bus.
 *
 * `probeHealth` is a lightweight HTTP GET that gates whether to attempt the
 * heavier auto-launch + WebSocket connection path. It still runs when the
 * launch is skipped, so an already-running server can win without
 * timeout-sensitive hooks blocking on a launch cycle.
 * @param busUrl - Resolved bus URL used for both probing and launch polling.
 * @param skipLaunch - When `true`, skip the desktop auto-launch step even if
 *   the health probe returns `null`. Used when the invocation targets a
 *   command that can embed its own bus.
 * @returns The final health result and whether a launch was attempted.
 */
async function probeCliHealthWithOptionalLaunch(busUrl: string, skipLaunch: boolean): Promise<CliHealthProbeResult> {
  const health = await probeHealth(busUrl);
  if (health) {
    return { health, backgroundLaunchAttempted: false };
  }

  if (skipLaunch) {
    return { health: null, backgroundLaunchAttempted: false };
  }

  const launchResult = await launchAppAndWaitForBus(busUrl);
  return {
    health: launchResult.health,
    backgroundLaunchAttempted: launchResult.launched,
  };
}

/**
 * Connection error reported when the built-in hook failure cool-down skipped
 * the probe. Purely informational — the hook action fails open on a `null` bus.
 */
const COOL_DOWN_CONNECTION_ERROR =
  'Makaio server marked unreachable by a recent failed hook; probe skipped during cool-down.';

/** Everything the invocation needs to know about its bus, however it was obtained. */
interface CliBusResolution {
  /** Health probe result, or `null` when unreachable or skipped. */
  readonly health: ServerHealth | null;
  /** Connected bus instance, or `null` when no bus is available. */
  readonly bus: IMakaioBus | null;
  /** Human-readable reason why no bus is available, when there is none. */
  readonly connectionError?: string;
  /** How the connection attempt ended when the probe succeeded but connect failed. */
  readonly connectionFailure?: 'auth' | 'transport';
  /** Whether the CLI attempted to launch the desktop app before returning. */
  readonly backgroundLaunchAttempted: boolean;
  /** Whether the hook failure cool-down suppressed the probe for this run. */
  readonly probeSkipped: boolean;
}

/** Inputs for {@link resolveBusForInvocation}. */
interface ResolveBusOptions {
  /** Processed argv vector (already had root flags stripped). */
  readonly parsedArgv: readonly string[];
  /** Whether the root `--debounce-failure` flag was given. */
  readonly debounceFailure: boolean;
  /** Resolved bus WebSocket URL. Never logged. */
  readonly busUrl: string;
  /** Whether to skip the desktop auto-launch after a failed probe. */
  readonly skipLaunch: boolean;
  /** Whether connection warnings should stay off stderr (help-only runs). */
  readonly suppressConnectionWarnings: boolean;
}

/**
 * Resolve the single bus for this invocation — either by skipping straight to
 * the no-bus path during a hook failure cool-down, or by probing health and
 * connecting.
 *
 * The skip branch is deliberately indistinguishable from an unreachable server
 * for everything downstream: Commander still parses and validates argv, and the
 * built-in hook action still runs and produces its documented fail-open result.
 * See `builtin-hook-debounce.ts` for why the cool-down predicate may be coarse.
 * @param options - Argv, cool-down inputs, and connection logging behaviour.
 * @returns The resolved bus and the context needed to classify the outcome.
 */
export async function resolveBusForInvocation(options: ResolveBusOptions): Promise<CliBusResolution> {
  const { parsedArgv, debounceFailure, busUrl, skipLaunch, suppressConnectionWarnings } = options;

  if (shouldSkipBusProbe(parsedArgv, debounceFailure, busUrl)) {
    return {
      health: null,
      bus: null,
      connectionError: COOL_DOWN_CONNECTION_ERROR,
      backgroundLaunchAttempted: false,
      probeSkipped: true,
    };
  }

  const { health, backgroundLaunchAttempted } = await probeCliHealthWithOptionalLaunch(busUrl, skipLaunch);
  const connection = await connectCliBus(health, { backgroundLaunchAttempted, suppressConnectionWarnings });
  return { health, backgroundLaunchAttempted, probeSkipped: false, ...connection };
}
