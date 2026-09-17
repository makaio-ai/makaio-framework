/**
 * Failure cool-down for built-in client hook commands (`hook handle` and
 * `hook received`).
 *
 * Both commands share the root flag `--debounce-failure`. When a recent bus
 * contact at the current CWD + bus-URL combination failed, a subsequent
 * invocation within the cool-down window skips the expensive part of the
 * invocation — the health probe and the WebSocket connect — and proceeds with
 * a `null` bus.
 *
 * **Contract:**
 * - The cool-down only decides whether to *probe*. It never returns early from
 *   `main`, never exits, and never writes output.
 * - **Commander still owns parsing.** Argv is not inspected beyond the command
 *   and subcommand name, so `--help`, a missing operand, an unknown option, or
 *   a malformed `--timeout` is reported by Commander exactly as it would be
 *   outside the cool-down.
 * - **The hook action owns the fail-open shape.** Running with a `null` bus is
 *   an existing, documented path in
 *   `extensions/client-hooks/src/cli/client-hook-command.ts`:
 *   `runClientHookHandleCommand` returns without output and without touching
 *   the exit code unless `--fail-close` was given (lines 453–459), and
 *   `runClientHookCommand` resolves normally because both bus helpers return
 *   on a `null` bus (lines 206–208 and 253–255). Both read stdin themselves,
 *   so no separate stdin drain is needed.
 *
 * Skipping the probe therefore only changes *how fast* a no-bus outcome is
 * reached, never *what* the CLI does with the argv. That is what makes the
 * coarse `argv[2]`/`argv[3]` predicate safe.
 *
 * The cool-down is keyed by `hash(cwd + '\n' + busUrl)` and stored as a
 * `*.hook.json` file in the same cache directory as the warning debounce, but
 * with a distinct suffix so the two families never collide. A failure under
 * bus configuration A therefore never silences configuration B.
 *
 * A `hook handle` invoked with `--fail-close` always probes: its contract is
 * that an unreachable bus exits non-zero, so it must be given the chance to
 * find a server that came back up and fail loudly when it did not. Such a run
 * may still *record* a failure — a fail-close run that found the server down is
 * real evidence.
 * @packageDocumentation
 */
import { resolveMakaioHome } from '@makaio/runtime-node';
import type { FallbackReason } from './parse-error.js';
import { recordHookCoolDown, shouldSuppressHookCoolDown } from './warning-debounce.js';

/**
 * `hook handle` option that turns an unreachable bus into a non-zero exit.
 *
 * A boolean Commander flag, so the literal argv check is exact — there is no
 * attached `--fail-close=…` spelling to miss.
 */
const FAIL_CLOSE_FLAG = '--fail-close';

/**
 * Build the composite deduplication key used by the hook cool-down.
 *
 * Keyed by CWD and bus URL so a failure under one bus configuration does not
 * silence a healthy second configuration at the same working directory. The
 * URL is never logged.
 * @param busUrl - Resolved bus WebSocket URL.
 * @returns The raw key; callers hash it before touching the filesystem.
 */
function buildHookKey(busUrl: string): string {
  return `${process.cwd()}\n${busUrl}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return whether the stripped argv addresses a built-in hook command.
 *
 * Root flags are stripped before this is called, so `argv[2]` is the top-level
 * command and `argv[3]` is the subcommand. Deliberately coarse: operands and
 * options are Commander's business, and a false positive only costs a skipped
 * probe on an invocation that Commander is about to reject anyway.
 * @param argv - Process argv after root config flags have been removed.
 * @returns `true` when the argv targets `hook handle` or `hook received`.
 */
export function isBuiltinHookInvocation(argv: readonly string[]): boolean {
  if (argv[2] !== 'hook') return false;
  const sub = argv[3];
  return sub === 'handle' || sub === 'received';
}

/**
 * Decide whether a built-in hook invocation should skip the health probe and
 * the bus connect because a recent server contact at the current CWD + bus-URL
 * failed and `--debounce-failure` is active.
 *
 * Never `true` for a `--fail-close` invocation, which must keep failing loudly.
 * @param argv - Process argv after root config flags have been removed.
 * @param debounceFailure - Whether `--debounce-failure` was given.
 * @param busUrl - Resolved bus WebSocket URL used as part of the cool-down
 *   key. Never logged.
 * @returns `true` when the invocation must run with a `null` bus without
 *   contacting the server.
 */
export function shouldSkipBusProbe(argv: readonly string[], debounceFailure: boolean, busUrl: string): boolean {
  if (!debounceFailure || !isBuiltinHookInvocation(argv) || argv.includes(FAIL_CLOSE_FLAG)) return false;
  return shouldSuppressHookCoolDown(resolveMakaioHome(), buildHookKey(busUrl));
}

/**
 * Outcome descriptor for {@link recordBuiltinHookFailure}.
 *
 * `connectionFailure` is `undefined` when a bus connected or the health probe
 * already returned `null` (no connection attempt was made).
 */
export interface HookFailureOutcome {
  /** Why no bus was available for this run (`'none'` when a bus was connected). */
  readonly fallback: FallbackReason;
  /**
   * How the connection attempt ended when the health probe succeeded but
   * `connectBusClient` threw:
   * - `'auth'` — authentication or configuration failure (e.g. wrong
   *   `MAKAIO_BUS_SECRET`). **Not recorded**: recording an auth failure would
   *   outlive the operator's fix and suppress hooks for the entire window after
   *   the secret is corrected.
   * - `'transport'` — transient transport failure (server exited between the
   *   probe and the WebSocket open, `/bus` stalled, etc.). **Recorded**: the
   *   same cost as an unreachable server.
   */
  readonly connectionFailure?: 'auth' | 'transport';
  /**
   * Whether {@link shouldSkipBusProbe} suppressed the probe for this run.
   *
   * A skipped probe produced no fresh evidence about the server, so it must
   * never refresh the marker — otherwise every hook inside the window would
   * extend the cool-down and it would never expire.
   */
  readonly probeSkipped: boolean;
}

/**
 * Record a server failure after a built-in hook ran without a bus, so the
 * next invocation within the cool-down window can skip the probe.
 *
 * Two outcomes are recorded:
 * - `fallback === 'unreachable'` — the health probe itself failed; the server
 *   is down.
 * - `fallback === 'connection-failed'` and `connectionFailure === 'transport'`
 *   — the probe succeeded but the WebSocket open failed for a non-auth reason
 *   (server exited between the calls, `/bus` stalled). This carries the same
 *   per-invocation cost as an unreachable server.
 *
 * `connectionFailure === 'auth'` is never recorded: it is a configuration
 * problem (missing or stale `MAKAIO_BUS_SECRET`) that the operator can fix
 * between invocations. Recording it would suppress hooks for the whole window
 * after the fix.
 *
 * `outcome.probeSkipped` short-circuits recording entirely: the run observed
 * nothing, so it must not extend its own cool-down.
 *
 * Unlike {@link shouldSkipBusProbe}, a `--fail-close` run may record — it
 * probed for real, and finding the server down is genuine evidence.
 * @param argv - Process argv after root config flags have been removed.
 * @param debounceFailure - Whether `--debounce-failure` was given.
 * @param outcome - Failure classification for this run.
 * @param busUrl - Resolved bus WebSocket URL used as part of the cool-down
 *   key. Never logged.
 */
export function recordBuiltinHookFailure(
  argv: readonly string[],
  debounceFailure: boolean,
  outcome: HookFailureOutcome,
  busUrl: string,
): void {
  const { fallback, connectionFailure, probeSkipped } = outcome;
  if (probeSkipped) return;
  const shouldRecord =
    fallback === 'unreachable' || (fallback === 'connection-failed' && connectionFailure === 'transport');
  if (debounceFailure && isBuiltinHookInvocation(argv) && shouldRecord) {
    recordHookCoolDown(resolveMakaioHome(), buildHookKey(busUrl));
  }
}
