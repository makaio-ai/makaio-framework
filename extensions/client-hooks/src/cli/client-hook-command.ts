/**
 * Generic client hook CLI bridge.
 *
 * Provides the core logic for:
 * - `makaio hook received <client> <event-name>` — fire-and-forget bridge.
 * - `makaio hook handle <client> <event-name>` — request/response bridge.
 *
 * Both commands share the same stdin-parsing and observation-emission path:
 * 1. Read JSON from stdin (fail-open on empty or invalid input).
 * 2. Build a non-owning raw catch-all subject for the specified client family
 *    (`client:<clientId>.hook.received`) and emit the event.
 * 3. When the metadata contains hard runtime evidence (`pid`,
 *    `supervisorSessionId`, or `adapterSessionId`), fire a best-effort
 *    `client.runtime.observe` request so the runtime registry can track
 *    the client process without coupling the hook bridge to a specific service.
 *
 * `handle` additionally issues a `bus.requestOptional` call on
 * `client:<clientId>.hook.handle` and translates the response into process
 * stdout, stderr, and exit code.
 *
 * **Invariants:**
 * - The bridge is intentionally dumb: it emits verbatim, never normalizes.
 * - Fail-open: bus unavailability or invalid stdin must not crash the process.
 * - No semantic interpretation of `eventName` — it passes through as-is.
 * - Only emits to `client:<clientId>.hook.received`, never to `client.session.*`.
 * - The runtime observation is best-effort: missing handlers are silently ignored.
 * - Observation (`hook.received`) is always emitted before the handle request —
 *   observation must never be lost due to a handle timeout or error.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { parseJsonMetadata, parseJsonPayload, readProcessStdinText, safeReadStdinText } from '@makaio/inbound-hooks';
import {
  ClientHookHandleResponseSchema,
  createRawClientHookHandleSubject,
  createRawClientHookReceivedSubject,
  pickNonEmptyStringValue,
  type RawClientHookPayload,
} from '@makaio/subsystem-client';
import type { CommandContext } from '@makaio/kernel/cli';

// ---------------------------------------------------------------------------
// Public args shape
// ---------------------------------------------------------------------------

/**
 * Parsed CLI argument shape for the `hook` command.
 *
 * Both positionals are required; `metadata` is an optional JSON flag for
 * pass-through context added by the native caller.
 */
export interface ClientHookArgs {
  /** Stable lowercase client identifier (e.g. `'codex'`, `'claude-code'`). */
  readonly client: string;
  /** Hook event name as reported by the native client (e.g. `'session_started'`). */
  readonly eventName: string;
  /**
   * Optional raw JSON string for pass-through metadata (e.g. process PID,
   * invocation context).  Parsed and forwarded verbatim; malformed JSON is
   * silently ignored to preserve fail-open semantics.
   */
  readonly metadataJson?: string;
}

// ---------------------------------------------------------------------------
// Narrow context interface (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Narrow command context used by {@link runClientHookCommand}.
 *
 * Extracting the minimal surface area makes the function fully testable
 * without constructing a real {@link CommandContext}.
 */
export interface ClientHookCommandContext {
  /** Parsed CLI arguments. */
  readonly args: ClientHookArgs;
  /**
   * Bus façade used to emit events and fire best-effort requests.
   *
   * `emit` is used for the primary `hook.received` event.
   * `requestOptional` is used for the best-effort `client.runtime.observe`
   * request — it silently succeeds when no handler is registered.
   *
   * May be `null` when the bus is unavailable; all bus calls are fail-open.
   */
  readonly bus: Pick<IMakaioBus, 'emit' | 'requestOptional'> | null;
}

// ---------------------------------------------------------------------------
// Injectable side-effects
// ---------------------------------------------------------------------------

/**
 * Side-effects bundle injected into {@link runClientHookCommand}.
 *
 * Using a plain object interface (rather than a class) keeps tests light:
 * each test supplies only the stubs it needs.
 */
export interface ClientHookCommandDependencies {
  /**
   * Read the full process stdin as a UTF-8 string.
   * @returns The raw stdin text, or an empty string when stdin is a TTY or
   *   the read fails.
   */
  readonly readStdinText: () => Promise<string>;
}

const defaultDependencies: ClientHookCommandDependencies = {
  readStdinText: readProcessStdinText,
};

// ---------------------------------------------------------------------------
// Shared payload builder
// ---------------------------------------------------------------------------

/**
 * Construct a {@link RawClientHookPayload} from the parsed stdin and metadata.
 *
 * Centralises the payload assembly so both the `received` and `handle` commands
 * produce identical payloads without duplicating the spread pattern.
 * @param eventName - Hook event name as reported by the native client.
 * @param payload - Parsed JSON object from stdin.
 * @param metadata - Parsed metadata record from `--metadata-json`, or `undefined`.
 * @returns A well-typed raw hook payload ready to emit on the bus.
 */
function buildHookPayload(
  eventName: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): RawClientHookPayload {
  return {
    eventName,
    receivedAt: Date.now(),
    payload,
    ...(metadata !== undefined && { metadata }),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * CLI entry handler for `makaio hook received <client> <event-name>`.
 *
 * Delegates to {@link runClientHookCommand} with process-level defaults.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleClientHook(ctx: CommandContext<ClientHookArgs>): Promise<void> {
  await runClientHookCommand(ctx, defaultDependencies);
}

/**
 * Execute the generic client hook bridge.
 *
 * Reads stdin, wraps the payload in a {@link RawClientHookPayload}-shaped
 * object, and emits it on `client:<clientId>.hook.received`.  When the
 * metadata contains hard runtime evidence, also fires a best-effort
 * `client.runtime.observe` request.  Always resolves — never rejects.
 * @param ctx - Narrow command context (args + bus).
 * @param deps - Injectable side-effects; defaults to process-level I/O.
 */
export async function runClientHookCommand(
  ctx: ClientHookCommandContext,
  deps: ClientHookCommandDependencies = defaultDependencies,
): Promise<void> {
  const { client, eventName, metadataJson } = ctx.args;

  const stdinText = await safeReadStdinText(deps.readStdinText);
  const payload = parseJsonPayload(stdinText);
  const metadata = parseJsonMetadata(metadataJson);

  const hookPayload = buildHookPayload(eventName, payload, metadata);

  await emitHookReceivedObservation(ctx.bus, client, hookPayload);
  safeEmitRuntimeObserve(ctx.bus, client, metadata);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fire a best-effort `client.runtime.observe` request when the metadata
 * contains at least one piece of hard runtime evidence.
 *
 * Hard evidence fields: `pid`, `supervisorSessionId`, or `adapterSessionId`.
 * When none are present the request is skipped entirely so the bus is not
 * polluted with evidence-free observations.
 *
 * Uses fire-and-forget (`void … .catch()`) so the hook bridge never blocks
 * waiting for the runtime-observe service — consistent with the other producers
 * (claude-agent-sdk, codex-app-server).
 * @param bus - Bus façade with `requestOptional` support, or `null` when unavailable.
 * @param clientId - Stable client identifier passed to the hook command.
 * @param metadata - Parsed metadata record from `--metadata-json`, or `undefined`.
 */
function safeEmitRuntimeObserve(
  bus: Pick<IMakaioBus, 'requestOptional'> | null,
  clientId: string,
  metadata: Record<string, unknown> | undefined,
): void {
  if (!bus) {
    return;
  }
  const rawPid = metadata?.pid;
  const pid = typeof rawPid === 'number' && Number.isInteger(rawPid) && rawPid > 0 ? rawPid : undefined;
  const supervisorSessionId = pickNonEmptyStringValue(metadata?.supervisorSessionId);
  const adapterSessionId = pickNonEmptyStringValue(metadata?.adapterSessionId);

  if (pid === undefined && supervisorSessionId === undefined && adapterSessionId === undefined) {
    return;
  }

  void bus
    .requestOptional(ClientSubjects.runtime.observe, {
      clientId,
      source: { layer: 'client-hook', producer: 'client-hook-command' },
      observedAt: Date.now(),
      pid,
      supervisorSessionId,
      adapterSessionId,
      metadata,
    })
    .catch(() => {
      // Fail open: observation errors must never propagate to the calling hook.
    });
}

/**
 * Emit the raw catch-all hook observation, swallowing bus errors.
 *
 * Both hook commands await this helper so the raw observation is attempted
 * before the process can return to the native client. Request-mode hooks may
 * bound the wait so a slow observation path cannot exceed the native response
 * budget before the handle request starts.
 * @param bus - Bus facade with `emit` support, or `null` when unavailable.
 * @param client - Stable client identifier passed to the hook command.
 * @param hookPayload - Raw hook payload to emit.
 * @param timeoutMs - Optional maximum wait for the observation emit.
 * @returns `true` when no bus exists or the observation completed within budget;
 *   `false` when the optional timeout elapsed first.
 */
async function emitHookReceivedObservation(
  bus: Pick<IMakaioBus, 'emit'> | null,
  client: string,
  hookPayload: RawClientHookPayload,
  timeoutMs?: number,
): Promise<boolean> {
  if (!bus) {
    return true;
  }

  let emitOperation: Promise<boolean>;
  try {
    const hookReceivedSubject = createRawClientHookReceivedSubject(client);
    emitOperation = Promise.resolve(bus.emit(hookReceivedSubject, hookPayload))
      .then(() => true)
      .catch(() => {
        // Fail open: bus unavailability must not break the calling client hook.
        return true;
      });
  } catch {
    // Fail open: malformed hook input must not break the calling client hook.
    return true;
  }

  if (timeoutMs === undefined) {
    return emitOperation;
  }

  return resolveWithinTimeout(emitOperation, timeoutMs);
}

/**
 * Resolve a promise within a positive millisecond budget.
 * @param operation - Operation to wait for.
 * @param timeoutMs - Maximum wait in milliseconds.
 * @returns The operation result, or `false` when the timeout wins.
 */
async function resolveWithinTimeout(operation: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return false;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, timeoutMs);
    });
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// ===========================================================================
// hook handle — request/response bridge
// ===========================================================================

/**
 * Parsed CLI argument shape for the `hook handle` subcommand.
 *
 * Extends the base hook args with timeout and fail-close controls for the
 * request/response round-trip on `client:<clientId>.hook.handle`.
 */
export interface ClientHookHandleArgs extends ClientHookArgs {
  /**
   * Maximum wait time for a bus response, in milliseconds.
   * Defaults to `5000` (5 seconds).
   */
  readonly timeout: number;
  /**
   * When `true`, a timeout or bus error causes a non-zero exit code (exit 1)
   * with an error message written to stderr.  When `false` (default), the
   * command exits 0 silently — fail-open semantics.
   */
  readonly failClose: boolean;
}

/**
 * Narrow command context used by {@link runClientHookHandleCommand}.
 *
 * Mirrors the shape of {@link ClientHookCommandContext} but carries
 * {@link ClientHookHandleArgs} and requires `requestOptional` on the bus.
 */
export interface ClientHookHandleCommandContext {
  /** Parsed CLI arguments including timeout and fail-close controls. */
  readonly args: ClientHookHandleArgs;
  /**
   * Bus façade used to emit events and issue the handle request.
   *
   * `emit` forwards the `hook.received` observation (fail-open).
   * `requestOptional` issues the `hook.handle` request/response round-trip.
   *
   * May be `null` when the bus is unavailable; all bus calls are fail-open
   * unless `--fail-close` is set.
   */
  readonly bus: Pick<IMakaioBus, 'emit' | 'requestOptional'> | null;
}

/**
 * Side-effects bundle injected into {@link runClientHookHandleCommand}.
 *
 * Extends {@link ClientHookCommandDependencies} with output channels so that
 * handler-driven stdout/stderr writes are captured in tests without touching
 * the real process streams.
 */
export interface ClientHookHandleCommandDependencies extends ClientHookCommandDependencies {
  /**
   * Write text to the process standard output channel.
   * @param text - Text to write verbatim.
   */
  readonly writeStdout: (text: string) => void;
  /**
   * Write text to the process standard error channel.
   * @param text - Text to write verbatim.
   */
  readonly writeStderr: (text: string) => void;
}

const defaultHandleDependencies: ClientHookHandleCommandDependencies = {
  readStdinText: readProcessStdinText,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

/**
 * CLI entry handler for `makaio hook handle <client> <event-name>`.
 *
 * Delegates to {@link runClientHookHandleCommand} with process-level defaults.
 * @param ctx - Full CLI command context supplied by the CLI framework.
 */
export async function handleClientHookHandle(ctx: CommandContext<ClientHookHandleArgs>): Promise<void> {
  await runClientHookHandleCommand(
    { args: ctx.args, bus: ctx.bus },
    {
      ...defaultHandleDependencies,
      writeStdout: (text) => {
        ctx.output.write(text);
      },
      writeStderr: (text) => {
        ctx.output.error(text);
      },
    },
    ctx.setExitCode.bind(ctx),
  );
}

/**
 * Execute the client hook handle bridge.
 *
 * Flow:
 * 1. Reads JSON from stdin (fail-open on empty or invalid input).
 * 2. Emits `hook.received` on the bus (fail-open, identical to the `received`
 *    command — observation is never lost).
 * 3. Fires a best-effort `client.runtime.observe` request when metadata
 *    contains hard runtime evidence.
 * 4. Issues a `bus.requestOptional` call on `client:<clientId>.hook.handle`.
 *    - `{ handled: true, data }` — writes `data.stdout` to stdout,
 *      `data.stderr` to stderr, and sets the exit code to `data.exitCode`.
 *    - `{ handled: false }` — exits 0 with no output (no handler registered).
 *    - Error / timeout — if `--fail-close` is set, writes the error to stderr
 *      and sets exit code 1; otherwise exits 0 silently (fail-open default).
 *
 * Always resolves — never rejects.
 * @param ctx - Narrow command context (args + bus).
 * @param deps - Injectable side-effects; defaults to process-level I/O.
 * @param setExitCode - Callback to signal a non-zero process exit code.
 *   Defaults to setting `process.exitCode` directly.
 */
export async function runClientHookHandleCommand(
  ctx: ClientHookHandleCommandContext,
  deps: ClientHookHandleCommandDependencies = defaultHandleDependencies,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): Promise<void> {
  const { client, eventName, metadataJson, timeout, failClose } = ctx.args;

  const stdinText = await safeReadStdinText(deps.readStdinText);
  const payload = parseJsonPayload(stdinText);
  const metadata = parseJsonMetadata(metadataJson);

  const hookPayload = buildHookPayload(eventName, payload, metadata);

  const deadline = Date.now() + timeout;

  // Step 1: always attempt hook.received first (fail-open, same payload as the
  // received command). The wait is bounded by the handle timeout so a slow
  // observation path cannot block the native request hook indefinitely.
  const observationCompleted = await emitHookReceivedObservation(ctx.bus, client, hookPayload, timeout);

  // Step 2: best-effort runtime observation (identical to received command).
  safeEmitRuntimeObserve(ctx.bus, client, metadata);

  // Step 3: request/response round-trip on hook.handle.
  if (!ctx.bus) {
    if (failClose) {
      deps.writeStderr('[hook handle] error: Makaio bus is unavailable.\n');
      setExitCode(1);
    }
    return;
  }

  const remainingTimeout = Math.max(0, deadline - Date.now());
  if (!observationCompleted || remainingTimeout === 0) {
    if (failClose) {
      deps.writeStderr(`[hook handle] error: timed out after ${timeout}ms before handle request.\n`);
      setExitCode(1);
    }
    return;
  }

  try {
    const hookHandleSubject = createRawClientHookHandleSubject(client);
    const result = await ctx.bus.requestOptional(hookHandleSubject, hookPayload, { timeout: remainingTimeout });

    if (result.handled) {
      // Parse through the schema so defaults (exitCode: 0, stdout: '', stderr: '')
      // are applied even when the handler returns a partial response object.
      const response = ClientHookHandleResponseSchema.parse(result.data);
      const { stdout, stderr, exitCode } = response;
      if (stdout) {
        deps.writeStdout(stdout);
      }
      if (stderr) {
        deps.writeStderr(stderr);
      }
      if (exitCode !== 0) {
        setExitCode(exitCode);
      }
    }
    // result.handled === false: no handler registered — exit 0 with no output.
  } catch (error) {
    if (failClose) {
      const message = error instanceof Error ? error.message : String(error);
      deps.writeStderr(`[hook handle] error: ${message}\n`);
      setExitCode(1);
    }
    // fail-open default: exit 0 silently.
  }
}
