/**
 * Native client supervisor commands.
 *
 * Registers the built-in `client` command tree which routes all operations
 * through the native-session-supervisor bus contracts rather than the Terminal
 * plugin directly.
 *
 * UX shape:
 * ```
 * makaio claude-code                                           # Launch Claude Code via supervisor
 * makaio claude-code attach <supervisorSessionId>              # Attach by supervisor ID
 * makaio claude-code attach --session <sessionId>              # Attach by session ID
 * makaio claude-code attach --adapter-session <id>             # Attach by adapter ID
 * makaio claude-code stop <supervisorSessionId>                # Stop a runtime
 * makaio claude-code status [supervisorSessionId]              # Query runtime status
 * ```
 *
 * All subcommands require an active bus connection; if the server is unreachable
 * the command fails immediately with a contextual error message.
 * @packageDocumentation
 */

import {
  NativeSessionSupervisorSubjects,
  type NativeSupervisorAttachRequest,
  type NativeSupervisorLaunchRequest,
  type NativeSupervisorStatusRequest,
  type NativeSupervisorStopRequest,
  type SupervisorRuntimeSnapshot,
} from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import { formatConnectionError } from './connection-error.js';
import {
  claimSubcommandName,
  findOrCreateCommand,
  hasRegisteredCommandName,
  type CommandInstance,
} from './command-tree.js';

// ---------------------------------------------------------------------------
// Native client definitions
// ---------------------------------------------------------------------------

/**
 * Native client command metadata required by the CLI shortcut layer.
 */
export interface NativeClientCliDefinition {
  /** Stable client package identifier used in supervisor metadata. */
  readonly clientId: string;
  /** Executable command to launch for the client. */
  readonly command: string;
  /** Human-readable display name for help text. */
  readonly displayName: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runtime context injected when registering native client commands.
 *
 * The bus is pre-connected and shared across the entire CLI invocation. When
 * `null` (server unreachable, auth failure), commands still register for
 * `--help` visibility but actions fail with the contextual error.
 *
 * The `clients` list is the app-owned bootstrapping table that enables
 * top-level `makaio <client>` shortcuts before server-side discovery is
 * reachable. App composition roots supply this list; when omitted no
 * top-level client shortcuts are registered.
 */
export interface NativeClientCommandContext {
  /**
   * Pre-connected bus instance shared across the entire CLI invocation.
   * `null` when the server connection failed.
   */
  readonly bus: IMakaioBus | null;
  /**
   * Human-readable reason the bus connection failed, or `undefined` when the
   * bus connected successfully.
   */
  readonly connectionError?: string;
  /**
   * Native client bootstrapping table for top-level `makaio <client>` shortcuts.
   *
   * Client shortcut identities belong here, supplied by the app composition
   * root. When omitted, no top-level shortcuts are registered (the generic
   * `client launch <id>` subcommand remains available).
   */
  readonly clients?: readonly NativeClientCliDefinition[];
}

/** Options accepted by native client launch commands. */
interface LaunchCommandOptions {
  /** Optional client profile name to materialize before launch. */
  readonly profile?: string;
}

/**
 * Register the built-in `client` command tree on the root Commander program.
 *
 * Creates a `client` parent command with `launch`, `attach`, `stop`, and
 * `status` subcommands that all route through `NativeSessionSupervisorSubjects`
 * on the bus. Only `launch` requires `<clientId>`; `attach` and `stop` are
 * keyed on `<supervisorSessionId>` or flag-based locators.
 * @param program - The root Commander program to attach the command to.
 * @param ctx - Bus and error context for the current CLI invocation.
 */
export function registerNativeClientCommand(program: CommandInstance, ctx: NativeClientCommandContext): void {
  const { cmd: clientCmd } = findOrCreateCommand(
    program,
    'client',
    'Launch and manage native client runtimes via the supervisor',
  );

  registerLaunchSubcommand(clientCmd, ctx);
  registerAttachSubcommand(clientCmd, ctx);
  registerStopSubcommand(clientCmd, ctx);
  registerStatusSubcommand(clientCmd, ctx);

  for (const client of ctx.clients ?? []) {
    registerNativeClientShortcut(program, client, ctx);
  }
}

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

/**
 * Register the `launch` subcommand.
 *
 * Derives the working directory from `process.cwd()` and uses the client ID
 * as both the identifier and the executable name. Callers that need fine-
 * grained control (explicit `command`, `args`, `env`) should use the bus API
 * directly rather than this CLI shortcut.
 * @param parent - Parent Commander command.
 * @param ctx - Bus and error context.
 */
function registerLaunchSubcommand(parent: CommandInstance, ctx: NativeClientCommandContext): void {
  if (!claimSubcommandName(parent, 'launch', `${parent.name()} launch`, 'native client')) return;
  parent
    .command('launch <clientId>')
    .description('Launch a client via the supervisor')
    .option('--profile <name>', 'Use a named client profile for session config')
    .action(async (clientId: string, options: LaunchCommandOptions) => {
      await handleLaunch(resolveNativeClientDefinition(clientId, ctx.clients ?? []), ctx, options);
    });
}

/**
 * Register the top-level `makaio <client>` supervisor-first shortcut.
 * @param program - Root Commander command.
 * @param client - Native client launch metadata.
 * @param ctx - Bus and error context.
 */
function registerNativeClientShortcut(
  program: CommandInstance,
  client: NativeClientCliDefinition,
  ctx: NativeClientCommandContext,
): void {
  if (hasRegisteredCommandName(program, client.clientId)) return;

  const clientCmd = program
    .command(client.clientId)
    .description(`Launch and manage ${client.displayName} via the native session supervisor`)
    .option('--profile <name>', 'Use a named client profile for session config')
    .action(async (options: LaunchCommandOptions) => {
      await handleLaunch(client, ctx, options);
    });

  registerAttachSubcommand(clientCmd, ctx);
  registerStopSubcommand(clientCmd, ctx);
  registerStatusSubcommand(clientCmd, ctx);
}

/**
 * Register the `attach` subcommand.
 *
 * Resolves the target runtime using one of three locators (in priority order):
 * 1. Positional `<supervisorSessionId>` (primary key returned by `launch`)
 * 2. `--session <sessionId>` (framework session ID)
 * 3. `--adapter-session <adapterSessionId>` (adapter-assigned session ID, documented seam)
 * @param parent - Parent Commander command.
 * @param ctx - Bus and error context.
 */
function registerAttachSubcommand(parent: CommandInstance, ctx: NativeClientCommandContext): void {
  if (!claimSubcommandName(parent, 'attach', `${parent.name()} attach`, 'native client')) return;
  parent
    .command('attach [supervisorSessionId]')
    .description('Attach to an existing supervised runtime')
    .option('--session <sessionId>', 'Locate runtime by framework session ID')
    .option('--adapter-session <adapterSessionId>', 'Locate runtime by adapter-assigned session ID')
    .action(
      async (
        supervisorSessionId: string | undefined,
        opts: { readonly session?: string; readonly adapterSession?: string },
      ) => {
        const result = buildAttachRequest(supervisorSessionId, opts.session, opts.adapterSession);
        if (!result.ok) {
          const message =
            result.reason === 'none'
              ? 'attach requires exactly one locator: <supervisorSessionId>, --session, or --adapter-session\n'
              : 'attach requires exactly one locator; multiple locators were provided\n';
          process.stderr.write(message);
          process.exitCode = 1;
          return;
        }
        await handleAttach(result.request, ctx);
      },
    );
}

/**
 * Register the `stop` subcommand.
 * @param parent - Parent Commander command.
 * @param ctx - Bus and error context.
 */
function registerStopSubcommand(parent: CommandInstance, ctx: NativeClientCommandContext): void {
  if (!claimSubcommandName(parent, 'stop', `${parent.name()} stop`, 'native client')) return;
  parent
    .command('stop <supervisorSessionId>')
    .description('Stop a supervised runtime by its supervisor session ID')
    .option('--signal <signal>', 'OS signal to send (default: SIGTERM)')
    .action(async (supervisorSessionId: string, opts: { readonly signal?: string }) => {
      const request: NativeSupervisorStopRequest = {
        supervisorSessionId,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      };
      await handleStop(request, ctx);
    });
}

/**
 * Register the `status` subcommand.
 *
 * When invoked without a supervisor session ID all supervised runtimes are
 * returned. The optional `[supervisorSessionId]` positional narrows the
 * result to that specific runtime.
 * @param parent - Parent Commander command.
 * @param ctx - Bus and error context.
 */
function registerStatusSubcommand(parent: CommandInstance, ctx: NativeClientCommandContext): void {
  if (!claimSubcommandName(parent, 'status', `${parent.name()} status`, 'native client')) return;
  parent
    .command('status [supervisorSessionId]')
    .description('Query status of one or all supervised runtimes')
    .action(async (supervisorSessionId: string | undefined) => {
      const request: NativeSupervisorStatusRequest = supervisorSessionId !== undefined ? { supervisorSessionId } : {};
      await handleStatus(request, ctx);
    });
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * Validate that the bus is connected and return it, or write the connection
 * error to stderr and set `process.exitCode = 1` before returning `null`.
 * @param ctx - Bus and error context for the current CLI invocation.
 * @returns The connected bus, or `null` when the connection failed.
 */
function requireConnectedBus(ctx: NativeClientCommandContext): IMakaioBus | null {
  if (ctx.bus) return ctx.bus;
  process.stderr.write(`${formatConnectionError(ctx.connectionError)}\n`);
  process.exitCode = 1;
  return null;
}

/**
 * Execute the `launch` operation by sending a supervisor launch request.
 * @param client - Native client launch metadata.
 * @param ctx - Bus and error context.
 * @param options - Parsed launch options.
 */
async function handleLaunch(
  client: NativeClientCliDefinition,
  ctx: NativeClientCommandContext,
  options: LaunchCommandOptions = {},
): Promise<void> {
  const bus = requireConnectedBus(ctx);
  if (!bus) return;

  const request: NativeSupervisorLaunchRequest = {
    clientId: client.clientId,
    cwd: process.cwd(),
    command: client.command,
    args: [],
    ...(options.profile !== undefined ? { clientProfileName: options.profile } : {}),
  };

  try {
    const response = await bus.request(NativeSessionSupervisorSubjects.launch, request);
    process.stdout.write(`Launched ${client.clientId}\n`);
    process.stdout.write(`  supervisor session: ${response.supervisorSessionId}\n`);
    process.stdout.write(`  pid: ${response.pid}\n`);
  } catch (err) {
    process.stderr.write(`Failed to launch ${client.clientId}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Execute the `attach` operation.
 * @param request - Typed attach request with exactly one locator field set.
 * @param ctx - Bus and error context.
 */
async function handleAttach(request: NativeSupervisorAttachRequest, ctx: NativeClientCommandContext): Promise<void> {
  const bus = requireConnectedBus(ctx);
  if (!bus) return;

  try {
    const response = await bus.request(NativeSessionSupervisorSubjects.attach, request);
    if (!response.success) {
      process.stderr.write('attach: runtime not found or attach failed\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Attached to runtime\n`);
    if (response.supervisorSessionId !== undefined) {
      process.stdout.write(`  supervisor session: ${response.supervisorSessionId}\n`);
    }
    if (response.pid !== undefined) {
      process.stdout.write(`  pid: ${response.pid}\n`);
    }
    if (response.terminalAttachment !== undefined) {
      process.stdout.write(`  can attach terminal: ${String(response.terminalAttachment.canAttach)}\n`);
    }
  } catch (err) {
    process.stderr.write(`attach failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Execute the `stop` operation.
 * @param request - Typed stop request.
 * @param ctx - Bus and error context.
 */
async function handleStop(request: NativeSupervisorStopRequest, ctx: NativeClientCommandContext): Promise<void> {
  const bus = requireConnectedBus(ctx);
  if (!bus) return;

  try {
    const response = await bus.request(NativeSessionSupervisorSubjects.stop, request);
    if (!response.success) {
      process.stderr.write(`stop: failed to stop runtime ${request.supervisorSessionId}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Stopped runtime ${request.supervisorSessionId}\n`);
  } catch (err) {
    process.stderr.write(`stop failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Execute the `status` query and print a summary of matching runtimes.
 * @param request - Typed status request (empty for all runtimes).
 * @param ctx - Bus and error context.
 */
async function handleStatus(request: NativeSupervisorStatusRequest, ctx: NativeClientCommandContext): Promise<void> {
  const bus = requireConnectedBus(ctx);
  if (!bus) return;

  try {
    const response = await bus.request(NativeSessionSupervisorSubjects.status, request);
    if (response.runtimes.length === 0) {
      process.stdout.write('No supervised runtimes found\n');
      return;
    }
    for (const runtime of response.runtimes) {
      printRuntimeSnapshot(runtime);
    }
  } catch (err) {
    process.stderr.write(`status failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Discriminated result from {@link buildAttachRequest}. */
export type AttachRequestResult =
  | { readonly ok: true; readonly request: NativeSupervisorAttachRequest }
  | { readonly ok: false; readonly reason: 'none' | 'multiple' };

/**
 * Build a typed attach request from the CLI inputs, enforcing exactly-one
 * locator semantics.
 *
 * Returns `{ ok: true, request }` when exactly one locator is provided, or
 * `{ ok: false, reason }` indicating whether zero (`'none'`) or multiple
 * (`'multiple'`) locators were supplied.
 * @param supervisorSessionId - Positional supervisor session ID.
 * @param sessionId - Framework session ID from `--session`.
 * @param adapterSessionId - Adapter session ID from `--adapter-session`.
 * @returns A discriminated result carrying the request or the failure reason.
 */
export function buildAttachRequest(
  supervisorSessionId: string | undefined,
  sessionId: string | undefined,
  adapterSessionId: string | undefined,
): AttachRequestResult {
  const count =
    (supervisorSessionId !== undefined ? 1 : 0) +
    (sessionId !== undefined ? 1 : 0) +
    (adapterSessionId !== undefined ? 1 : 0);

  if (count === 0) return { ok: false, reason: 'none' };
  if (count > 1) return { ok: false, reason: 'multiple' };

  if (supervisorSessionId !== undefined) {
    return { ok: true, request: { supervisorSessionId } };
  }
  if (sessionId !== undefined) {
    return { ok: true, request: { sessionId } };
  }
  return { ok: true, request: { adapterSessionId: adapterSessionId as string } };
}

/**
 * Resolve CLI launch metadata for a client ID.
 *
 * Known clients (from the supplied list) use their declared binary names.
 * Unknown client IDs fall back to `command = clientId`, preserving the generic
 * management command as a thin bus convenience while keeping top-level
 * shortcuts canonical.
 * @param clientId - Stable client package identifier.
 * @param clients - Client bootstrapping table to search, supplied by the
 *   app composition root.
 * @returns Launch metadata for the supplied client ID.
 */
export function resolveNativeClientDefinition(
  clientId: string,
  clients: readonly NativeClientCliDefinition[],
): NativeClientCliDefinition {
  return (
    clients.find((client) => client.clientId === clientId) ?? {
      clientId,
      command: clientId,
      displayName: clientId,
    }
  );
}

/**
 * Print a human-readable single-line summary of a runtime snapshot.
 * @param runtime - The snapshot to print.
 */
function printRuntimeSnapshot(runtime: SupervisorRuntimeSnapshot): void {
  const pid = runtime.pid !== null ? String(runtime.pid) : '-';
  const started = new Date(runtime.startedAt).toISOString();
  process.stdout.write(
    `${runtime.supervisorSessionId}  ${runtime.clientId}  pid=${pid}  ${runtime.status}  ${started}\n`,
  );
  if (runtime.sessionId !== undefined) {
    process.stdout.write(`  session: ${runtime.sessionId}\n`);
  }
}
