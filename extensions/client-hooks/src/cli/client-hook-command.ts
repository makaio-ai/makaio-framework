/**
 * Generic client hook CLI bridge.
 *
 * Provides the core logic for `makaio hook received <client> <event-name>`:
 *
 * 1. Reads JSON from stdin (fail-open on empty or invalid input).
 * 2. Builds a non-owning raw catch-all subject for the specified client
 *    family (`client:<clientId>.hook.received`).
 * 3. Emits the raw event with `eventName`, `receivedAt`, `payload`, and
 *    optional `metadata` flags.
 * 4. When the metadata contains hard runtime evidence (`pid`,
 *    `supervisorSessionId`, or `adapterSessionId`), fires a best-effort
 *    `client.runtime.observe` request so the runtime registry can track
 *    the client process without coupling the hook bridge to a specific service.
 *
 * **Invariants:**
 * - The bridge is intentionally dumb: it emits verbatim, never normalizes.
 * - Fail-open: bus unavailability or invalid stdin must not crash the process.
 * - No semantic interpretation of `eventName` — it passes through as-is.
 * - Only emits to `client:<clientId>.hook.received`, never to `client.session.*`.
 * - The runtime observation is best-effort: missing handlers are silently ignored.
 * @packageDocumentation
 */

import { text as readStreamText } from 'node:stream/consumers';
import type { IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { createRawClientHookReceivedSubject, pickNonEmptyStringValue } from '@makaio/clients-core';
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

  const stdinText = await safeReadStdinText(deps);
  const payload = parseJsonPayload(stdinText);
  const metadata = parseJsonMetadata(metadataJson);

  const hookPayload = {
    eventName,
    receivedAt: Date.now(),
    payload,
    ...(metadata !== undefined && { metadata }),
  };

  if (ctx.bus) {
    try {
      const hookReceivedSubject = createRawClientHookReceivedSubject(client);
      await ctx.bus.emit(hookReceivedSubject, hookPayload);
    } catch {
      // Fail open: bus unavailability must not break the calling client hook.
    }
  }

  safeEmitRuntimeObserve(ctx.bus, client, metadata);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read stdin without surfacing failures to the caller.
 * @param deps - Dependency bundle.
 * @returns The full stdin text, or an empty string on any failure.
 */
async function safeReadStdinText(deps: ClientHookCommandDependencies): Promise<string> {
  try {
    return await deps.readStdinText();
  } catch {
    return '';
  }
}

/**
 * Trim, parse, and type-guard a raw string as a JSON object.
 *
 * Returns `undefined` when the input is blank, not valid JSON, or not a
 * plain object. Callers decide their own fallback semantics.
 * @param text - Raw string to parse.
 * @returns A plain `Record<string, unknown>`, or `undefined` on failure.
 */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through — non-JSON or non-object input returns undefined.
  }

  return undefined;
}

/**
 * Parse a JSON object from raw stdin text.
 *
 * Returns an empty object when the input is blank, non-JSON, or does not
 * parse to an object. This preserves fail-open semantics: an event is always
 * emitted even when the native caller sends nothing or malformed data.
 * @param text - Raw text to parse.
 * @returns A plain `Record<string, unknown>` or `{}` on failure.
 */
function parseJsonPayload(text: string): Record<string, unknown> {
  return parseJsonObject(text) ?? {};
}

/**
 * Parse an optional JSON metadata string from a CLI flag.
 *
 * Returns `undefined` when absent or unparseable so the caller can omit the
 * `metadata` field from the emitted payload entirely (rather than emitting
 * `{}`).
 * @param raw - Raw JSON string from `--metadata-json`, or `undefined`.
 * @returns A parsed metadata record, or `undefined` on absence or parse failure.
 */
function parseJsonMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  return parseJsonObject(raw);
}

/**
 * Read the current process stdin as UTF-8 text.
 *
 * Returns an empty string when stdin is an interactive TTY so the command
 * does not hang waiting for user input.
 * @param stdin - The stdin stream to consume (defaults to `process.stdin`).
 * @returns The full stdin text, or an empty string for a TTY.
 */
async function readProcessStdinText(stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stdin.isTTY === true) {
    return '';
  }

  return readStreamText(stdin);
}

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
