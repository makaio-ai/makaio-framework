/**
 * Light hook path: runs `hook received|handle` without loading the full CLI.
 *
 * The path is taken only on success. When the bus cannot be reached within the
 * fast-connect deadline the function returns `'fallback'` before reading stdin
 * or writing anything, and the caller re-runs the invocation through the full
 * Commander path (health probe, launch handling, failure cool-down recording,
 * fail-close reporting). The full path therefore remains the single owner of
 * every failure semantic.
 *
 * Runtime imports are deliberately limited to the fast bus connection, the
 * client-hooks runners, the cool-down predicate, and node built-ins.
 * @packageDocumentation
 */
import os from 'node:os';
import path from 'node:path';
import { runClientHookCommand, runClientHookHandleCommand } from '@makaio/extension-client-hooks/hook-runner';
import { connectFastHookBus, DEFAULT_FAST_HOOK_BUS_URL } from '@makaio/inbound-hooks/fast-connection';
import { DEFAULT_HOOK_HANDLE_TIMEOUT_MS } from '@makaio/subsystem-client/hook-subjects';
import { isHookCoolDownActive } from './builtin-hook-debounce.js';
import type { LightHookInvocation } from './hook-fast-path-detect.js';

/** Bus type accepted by the client-hooks runners (`null` for the fail-open no-bus run). */
type RunnerBus = Parameters<typeof runClientHookCommand>[0]['bus'];

/**
 * Options for {@link runLightHookInvocation}.
 */
export interface RunLightHookOptions {
  /** Environment used for `MAKAIO_BUS_URL` and `MAKAIO_HOME`; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the bus URL exactly like `resolveBusUrl` in `bus-client.ts`.
 * @param env - Environment snapshot.
 * @returns Trimmed `MAKAIO_BUS_URL`, else the default URL.
 * @internal Exported only for the parity test against `resolveBusUrl`.
 */
export function resolveLightBusUrl(env: NodeJS.ProcessEnv): string {
  const declared = env['MAKAIO_BUS_URL']?.trim() ?? '';
  return declared.length > 0 ? declared : DEFAULT_FAST_HOOK_BUS_URL;
}

/**
 * Resolve the MAKAIO home like `resolveMakaioHome`.
 *
 * Source of truth: `resolveMakaioHome` in `runtimes/node/src/makaio-config.ts`.
 * Re-implemented here because importing it would pull the heavy runtime-node
 * graph into the light path; a parity test guards against drift.
 * @param env - Environment snapshot.
 * @returns Absolute MAKAIO home path.
 * @internal Exported only for the parity test against `resolveMakaioHome`.
 */
export function resolveLightMakaioHome(env: NodeJS.ProcessEnv): string {
  const declared = env['MAKAIO_HOME']?.trim();
  return declared && declared.length > 0 ? path.resolve(declared) : path.join(os.homedir(), '.makaio');
}

/**
 * Report an unexpected error raised after the runner took over stdin, with the
 * runner's own fail-open shape: silent exit 0, or one stderr line and exit 1
 * under `--fail-close`.
 * @param invocation - The invocation being run.
 * @param error - The unexpected error.
 */
function failLikeRunner(invocation: LightHookInvocation, error: unknown): void {
  if (!invocation.failClose) return;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[hook ${invocation.command}] error: ${message}\n`);
  process.exitCode = 1;
}

/**
 * Run the selected hook command against the given bus (or none).
 * @param invocation - The parsed invocation.
 * @param bus - Connected bus, or `null` for the fail-open no-bus run.
 */
async function runWithBus(invocation: LightHookInvocation, bus: RunnerBus): Promise<void> {
  const { client, eventName, metadataJson } = invocation;
  if (invocation.command === 'received') {
    await runClientHookCommand({ args: { client, eventName, metadataJson }, bus });
    return;
  }
  await runClientHookHandleCommand({
    args: {
      client,
      eventName,
      metadataJson,
      timeout: invocation.timeout ?? DEFAULT_HOOK_HANDLE_TIMEOUT_MS,
      failClose: invocation.failClose,
    },
    bus,
  });
}

/**
 * Run a light hook invocation when the bus is reachable, or when the failure
 * cool-down says to run without one.
 *
 * Returns `'fallback'` only before stdin was read and before anything was
 * written, so the caller can safely hand the same argv to the full CLI path.
 * Never throws: an unexpected error after the runner took over is reported in
 * the runner's fail-open shape and still returns `'handled'`.
 * @param invocation - Invocation from `parseLightHookInvocation`.
 * @param options - Optional environment override.
 * @returns `'handled'` when the invocation ran to completion, `'fallback'` when the full path must run it.
 */
export async function runLightHookInvocation(
  invocation: LightHookInvocation,
  options: RunLightHookOptions = {},
): Promise<'handled' | 'fallback'> {
  const env = options.env ?? process.env;
  let connection: Awaited<ReturnType<typeof connectFastHookBus>> = null;

  try {
    const busUrl = resolveLightBusUrl(env);
    const cooledDown = isHookCoolDownActive({
      debounceFailure: invocation.debounceFailure,
      failClose: invocation.failClose,
      busUrl,
      makaioHome: resolveLightMakaioHome(env),
    });
    if (!cooledDown) {
      // Hooks connect as an anonymous shared-secret HMAC peer: no `makaio-cli-local` identity
      // (least privilege; hook.received / hook.handle / runtime.observe do not check the peer,
      // the identity only gates supervisor control). Auth is not gated on a /health probe because
      // the probe is exactly what this path avoids; a blank or invalid secret fails the connect
      // and falls back to the full path, which reports it.
      // `debug` is intentionally not passed: the transport follows MAKAIO_DEBUG, makaio's own debug
      // switch, same as `connectBusClient` on the full path. `connectFastHookBus` routes the
      // transport's debug lines to stderr, because stdout is the hook response channel.
      connection = await connectFastHookBus({ name: `client-hook-${invocation.client}`, busUrl });
      // On fallback the full path probes/connects again; accepted — refused ports fail fast and
      // the cool-down suppresses repeats.
      if (connection === null) return 'fallback';
    }
  } catch {
    // Only guards unexpected setup errors; nothing was read or written yet.
    return 'fallback';
  }

  try {
    await runWithBus(invocation, connection?.bus ?? null);
  } catch (error) {
    // Only guards the runners' documented never-reject contract.
    failLikeRunner(invocation, error);
  } finally {
    connection?.dispose();
    // TODO(FACT-393): under Node (dev CLI, Electron) ws keeps a referenced 30 s close timer when the peer stalls the close handshake; Bun (shipped Electrobun launcher) is unaffected. Needs a transport-level closeTimeoutMs.
  }
  return 'handled';
}
