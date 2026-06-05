/**
 * CLI entry point — runs as `ELECTRON_RUN_AS_NODE=1` or standalone Node.js.
 *
 * Parses argv, discovers CLI contributions from locally-installed extensions
 * and (when the server is reachable) from bus-RPC, then dispatches to the
 * matched handler.
 *
 * Local filesystem discovery runs first so that extensions with interactive
 * TUI handlers can execute in-process. Bus-RPC discovery fills in any
 * commands not available locally (e.g. future remote-only extensions).
 */
import { pathToFileURL } from 'node:url';
import { Command, InvalidOptionArgumentError } from 'commander';
import { clientHooksCli } from '@makaio/extension-client-hooks';
import type { CliManifest, CliSubcommandManifest } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import { toCliArgManifests, CliRpcSubjects } from '@makaio/kernel/cli';
import type { CliContribution } from '@makaio/kernel/cli';
import { resolveConventionEntrypoint, resolveMakaioHome, type ExtensionDiscovery } from '@makaio/runtime-node';
import { registerContribution } from './schema-adapter.js';
import {
  connectBusClient,
  isAuthConnectionError,
  probeHealth,
  resolveClientAuth,
  resolveBusUrl,
} from './bus-client.js';
import { launchAppAndWaitForBus } from './app-launch.js';
import type { ServerHealth } from './bus-client.js';
import { disconnectBusSafely } from './command-runtime.js';
import { registerManifestCommand, registerManifestArgs, collectPositionalArgs } from './manifest-commands.js';
import { registerExtensionCommands } from './extension-commands.js';
import { hasRegisteredCommandName, type CommandInstance } from './command-tree.js';
import { serve, type ServeBootOverrides } from './serve.js';
import { registerNativeClientCommand, type NativeClientCliDefinition } from './native-client-command.js';
import { registerMcpServerCommand } from './mcp-server-command.js';
import { resolveCliRuntimeConfig } from './runtime-config.js';
import { registerOpenCommand } from './open-command.js';
import { registerAutoLaunchCommand } from './auto-launch-command.js';
import { registerSetupCommand } from './setup-command.js';
import { registerInstallCommand } from './install-command.js';
import { handleParseError, applyFallbackOverrides, type FallbackReason } from './parse-error.js';

export { extractRootConfigArg } from './runtime-config.js';

/**
 * Native clients supported by this CLI entrypoint.
 *
 * This list lives at the app composition root so native-client shortcuts
 * (`clientId`, `command`) do not leak into the reusable
 * `registerNativeClientCommand` module. Rich client definitions
 * (icons, descriptions, capabilities) belong in the client packages
 * themselves; only the minimal CLI bootstrapping metadata is kept here.
 */
const NATIVE_CLIENTS: readonly NativeClientCliDefinition[] = [
  { clientId: 'claude-code', command: 'claude', displayName: 'Claude Code' },
  { clientId: 'codex', command: 'codex', displayName: 'Codex' },
  { clientId: 'gemini', command: 'gemini', displayName: 'Gemini' },
  { clientId: 'qwen', command: 'qwen', displayName: 'Qwen Code' },
];

/**
 * CLI contributions provided directly by the framework CLI.
 *
 * The hook bridge must be available before extension discovery because native
 * client hooks are often invoked from isolated subprocesses where no product
 * config or installed-extension catalog is available.
 */
const BUILTIN_CLI_CONTRIBUTIONS: readonly CliContribution[] = [clientHooksCli];

/**
 * Determine whether argv is asking Commander to render help without dispatching
 * a command handler.
 * @param argv - Raw process argv vector.
 * @returns `true` when the invocation is help-only.
 */
function isHelpOnlyInvocation(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/**
 * Host-provided configuration for the `serve` built-in command.
 *
 * Programmatic hosts inject resolver implementations here at boot time.
 * Standalone CLI execution omits this entirely — each field is optional.
 */
export interface ServeConfig {
  /**
   * Resolve a peer device's signing public key for E2E relay authentication.
   * @see {@link ServeOptions.peerSigningKeyResolver}
   */
  peerSigningKeyResolver?: (peerId: string) => Promise<CryptoKey | null>;
  /**
   * Optional host-owned boot overrides forwarded to {@link serve}.
   */
  boot?: ServeBootOverrides;
}

/**
 * Determine whether argv can be handled without server-side command discovery.
 *
 * Only strictly local builtins qualify here. Help output and bare invocation
 * still benefit from discovery when the server is reachable because remote
 * commands should appear in the command tree before Commander renders help.
 * @param argv - Raw process argv vector.
 * @returns `true` when discovery can be skipped safely.
 */
export function isDiscoveryFreeBuiltin(argv: readonly string[]): boolean {
  const subcommand = argv[2];
  return (
    subcommand === 'serve' ||
    subcommand === 'extension' ||
    subcommand === 'open' ||
    subcommand === 'auto-launch' ||
    subcommand === 'install' ||
    argv.includes('--version') ||
    argv.includes('-V')
  );
}

/**
 * Parse and validate a CLI port argument.
 *
 * Rejects non-integer strings (including partial parses like "6252abc") and
 * values outside the valid TCP port range.
 * @param value - Raw string value from the CLI option.
 * @returns The validated port as a number.
 * @throws InvalidOptionArgumentError When the value is not a valid port integer.
 */
function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidOptionArgumentError('Port must be an integer');
  }
  const port = Number(value);
  if (port < 0 || port > 65535) {
    throw new InvalidOptionArgumentError('Port must be between 0 and 65535');
  }
  return port;
}

/**
 * Create and configure the root Commander program with builtins only.
 * @param serveConfig - Host-provided configuration for the `serve` command.
 * @returns The configured Commander program.
 */
export function createProgram(serveConfig?: ServeConfig): CommandInstance {
  const program = new Command('makaio').description('Makaio CLI — orchestrate AI agents').version('0.1.0');

  registerOpenCommand(program);
  registerAutoLaunchCommand(program);
  registerInstallCommand(program, { makaioHome: resolveMakaioHome() });

  // Built-in: serve command (starts the headless server)
  program
    .command('serve')
    .description('Start the Makaio server (bus + services + HTTP)')
    .option('-p, --port <port>', 'HTTP/WebSocket port', parsePort, 6252)
    .option('--host <host>', 'Bind address override')
    .option('--lan-bind', 'Bind on all interfaces for LAN access (enables E2E auth)')
    .action(async (opts: { port: number; host?: string; lanBind?: boolean }) => {
      await serve({
        port: opts.port,
        host: opts.host,
        lanBind: opts.lanBind,
        peerSigningKeyResolver: serveConfig?.peerSigningKeyResolver,
        boot: serveConfig?.boot,
      });
    });

  registerExtensionCommands(program);

  return program;
}

/**
 * Register a remote CLI command that dispatches via `cli.execute` RPC.
 *
 * Creates Commander commands from the manifest's metadata. When a subcommand
 * action fires, it calls `cli.execute` on the server and prints the output.
 * @param program - The root Commander program.
 * @param manifest - CLI manifest from `cli.listContributions`.
 * @param bus - Connected bus instance.
 */
function registerRemoteCommand(program: CommandInstance, manifest: CliManifest, bus: IMakaioBus): void {
  // Remote commands are a fallback — skip entirely when a local or built-in
  // registration already owns this name. No merge: local always wins.
  if (hasRegisteredCommandName(program, manifest.name)) return;

  const cmd = program.command(manifest.name).description(manifest.description);

  for (const sub of manifest.subcommands ?? []) {
    registerRemoteSubcommand(cmd, manifest.name, sub, bus);
  }

  if (manifest.hasInteractive) {
    cmd.action(() => {
      console.error(
        `Command "${manifest.name}" requires an interactive entry point, which is not supported via remote RPC execution.`,
      );
      process.exitCode = 1;
    });
  }
}

/**
 * Convert a filesystem entry path into an ESM import specifier.
 * @param entryPath - Absolute filesystem path to the CLI entry module.
 * @returns File-URL import specifier compatible with Node ESM loaders.
 */
export function toCliModuleImportSpecifier(entryPath: string): string {
  return pathToFileURL(entryPath).href;
}

/**
 * Register a single remote subcommand.
 * @param parent - Parent Commander command.
 * @param commandName - Top-level command name for the RPC call.
 * @param sub - Subcommand manifest.
 * @param bus - Connected bus instance.
 */
function registerRemoteSubcommand(
  parent: CommandInstance,
  commandName: string,
  sub: CliSubcommandManifest,
  bus: IMakaioBus,
): void {
  const cmd = parent.command(sub.name).description(sub.description);
  registerManifestArgs(cmd, sub.args ?? []);

  cmd.action(async () => {
    const rawOpts = cmd.opts();
    const rawArgs = collectPositionalArgs(cmd);
    const merged = { ...rawOpts, ...rawArgs };

    try {
      const result = await bus.request(CliRpcSubjects.execute, {
        command: commandName,
        subcommand: sub.name,
        args: Object.keys(merged).length > 0 ? merged : undefined,
      });

      for (const line of result.stdout) process.stdout.write(line);
      for (const line of result.stderr) process.stderr.write(line);
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    } catch (err) {
      process.stderr.write(`Command failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  });
}

/**
 * A locally-discovered extension ready for Commander registration.
 *
 * Produced by {@link discoverLocalExtensions}, consumed by the registration
 * loop in {@link main}. Keeps discovery (pure data) separate from
 * registration (side effect on the Commander tree that needs the bus).
 */
export interface LocalExtensionRegistration {
  /** CLI manifest enriched with live Zod schema args. */
  readonly manifest: CliManifest;
  /** Absolute path to the extension's CLI entry module. */
  readonly cliEntryPath: string;
  /** Whether the contribution exports an interactive handler. */
  readonly hasInteractive: boolean;
  /** Dynamic import function for the extension's CLI entry module. */
  readonly importModule: (entryPath: string) => Promise<CliContribution>;
}

/**
 * Discover locally-installed extensions eligible for CLI registration.
 *
 * Scans the filesystem for extension descriptors, validates entrypoints, and
 * enriches manifests with live Zod schema args. Returns registration data
 * without touching the Commander tree — the caller handles registration so
 * that bus wiring stays in {@link main}.
 * @param program - The Commander program (used only to check for name collisions).
 * @param discovery - Extension discovery strategy.
 * @param injectedNames - Names of pre-loaded contributions to skip.
 * @returns Registrations ready for {@link registerManifestCommand}.
 */
export async function discoverLocalExtensions(
  program: CommandInstance,
  discovery: ExtensionDiscovery,
  injectedNames: ReadonlySet<string>,
): Promise<readonly LocalExtensionRegistration[]> {
  let discovered: Awaited<ReturnType<ExtensionDiscovery['discover']>>;
  try {
    discovered = await discovery.discover();
  } catch (err) {
    console.warn('[cli] Local extension discovery failed, skipping:', err instanceof Error ? err.message : err);
    return [];
  }

  const registrations: LocalExtensionRegistration[] = [];
  const discoveredNames = new Set<string>();

  for (const ext of discovered) {
    const { descriptor, extensionPath } = ext;
    if (!descriptor.cli) continue;
    // Detached extensions run as child processes and have no entrypoints to import.
    if (descriptor.execution === 'detached') continue;
    // Deduplicate against both already-registered names and this discovery
    // batch itself. Two local extensions declaring the same cli.name is an
    // authoring error — first-discovered wins. Cross-path merging (e.g. a
    // built-in and an extension sharing a parent) is handled
    // downstream by findOrCreateCommand at registration time.
    if (
      injectedNames.has(descriptor.cli.name) ||
      discoveredNames.has(descriptor.cli.name) ||
      hasRegisteredCommandName(program, descriptor.cli.name)
    ) {
      continue;
    }
    const cliEntrypoint = descriptor.entrypoints.cli;
    if (!cliEntrypoint) continue;
    const cliEntryPath = resolveConventionEntrypoint('cli', cliEntrypoint, extensionPath);
    if (!cliEntryPath) {
      console.warn(
        `[cli] Skipping extension '${descriptor.name}': cli entrypoint has no resolvable candidate within extension directory.`,
      );
      continue;
    }

    const importModule = (entryPath: string): Promise<CliContribution> =>
      import(toCliModuleImportSpecifier(entryPath)).then((mod: { default?: CliContribution }) => {
        const contribution = mod.default;
        if (!contribution) {
          throw new Error(`Module at ${entryPath} does not have a default export`);
        }
        return contribution;
      });

    const enrichedManifest = await enrichManifestFromLiveSchema(descriptor.cli, cliEntryPath, importModule);

    registrations.push({
      manifest: enrichedManifest,
      cliEntryPath,
      hasInteractive: descriptor.cli.hasInteractive === true,
      importModule,
    });
    discoveredNames.add(descriptor.cli.name);
  }

  return registrations;
}

/**
 * Overlay each subcommand's `args` with the manifest produced by introspecting
 * the live Zod schema exported by the extension's CLI module.
 *
 * The Zod schema — with `.meta()` annotations — is the single source of truth
 * for CLI options and positionals. The static `descriptor.json` keeps only
 * stable pointer metadata (subcommand names and descriptions) so the top-level
 * help tree can render without importing extension code, while the richer
 * arg metadata is derived on demand here.
 *
 * Falls back to the descriptor as-is when the extension module cannot be
 * loaded — command names still register so `--help` keeps working, and the
 * import failure surfaces again with full context when the user dispatches.
 * @param manifest - The static CLI manifest loaded from `descriptor.json`.
 * @param cliEntryPath - Absolute path to the extension's CLI entry module.
 * @param importModule - Dynamic import factory (injected for tests).
 * @returns A manifest whose `subcommands[].args` match the live schema.
 */
async function enrichManifestFromLiveSchema(
  manifest: CliManifest,
  cliEntryPath: string,
  importModule: (entryPath: string) => Promise<CliContribution>,
): Promise<CliManifest> {
  let contribution: CliContribution;
  try {
    contribution = await importModule(cliEntryPath);
  } catch (err) {
    console.warn(
      `[cli] Failed to introspect CLI schema for '${manifest.name}' at ${cliEntryPath} — falling back to descriptor manifest:`,
      err instanceof Error ? err.message : err,
    );
    return manifest;
  }

  if (!Array.isArray(contribution.subcommands)) {
    console.warn(
      `[cli] CLI module for '${manifest.name}' at ${cliEntryPath} has no subcommands array — falling back to descriptor manifest.`,
    );
    return manifest;
  }

  const liveSubcommands = contribution.subcommands;
  const subcommands: CliSubcommandManifest[] = (manifest.subcommands ?? []).map((sub) => {
    const entry = liveSubcommands.find((s) => s.name === sub.name);
    if (!entry) return sub;
    try {
      return { ...sub, args: toCliArgManifests(entry.schema) };
    } catch (err) {
      // A malformed schema on one subcommand must not poison discovery of
      // sibling subcommands or later extensions — fall back to whatever args
      // the descriptor declared for this one entry.
      console.warn(
        `[cli] Failed to derive CLI args for '${manifest.name}.${sub.name}' from live schema — falling back to descriptor args:`,
        err instanceof Error ? err.message : err,
      );
      return sub;
    }
  });

  return { ...manifest, subcommands };
}

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
): Promise<{ bus: IMakaioBus | null; connectionError?: string }> {
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
      return { bus: null, connectionError: `Bus authentication failed: ${message}` };
    }
    if (!options?.suppressConnectionWarnings) {
      console.warn('[cli] Could not connect to server:', message);
    }
    return { bus: null, connectionError: `Could not connect to Makaio server: ${message}` };
  }
}

interface CliHealthProbeResult {
  /** Health probe result after optional background launch. */
  readonly health: ServerHealth | null;
  /** Whether the CLI attempted to launch the desktop app before returning. */
  readonly backgroundLaunchAttempted: boolean;
}

/**
 * Determine whether the current invocation targets a locally-discovered
 * extension that declares it can provide its own embedded bus.
 *
 * When `true`, the CLI router can skip the desktop auto-launch path because
 * the targeted extension will bootstrap a self-contained bus via
 * `CliContribution.provideBus`. An external bus can still win if the health
 * probe returns a live server.
 * @param parsedArgv - Processed argv vector (already had root flags stripped).
 * @param localExtensions - Extensions discovered from the local filesystem.
 * @returns `true` when `argv[2]` names a locally-registered extension with
 *   `canProvideBus: true` in its manifest.
 */
export function canInvocationProvideBus(
  parsedArgv: readonly string[],
  localExtensions: readonly LocalExtensionRegistration[],
): boolean {
  const commandName = parsedArgv[2];
  if (!commandName) return false;
  return localExtensions.some((ext) => ext.manifest.name === commandName && ext.manifest.canProvideBus === true);
}

/**
 * Determine whether the CLI should skip desktop auto-launch after the initial
 * health probe fails.
 * @param parsedArgv - Processed argv vector (already had root flags stripped).
 * @param localExtensions - Extensions discovered from the local filesystem.
 * @param noLaunch - Root `--no-launch` flag extracted from the invocation.
 * @returns `true` when the invocation should fail through without launch.
 */
function shouldSkipDesktopAutoLaunch(
  parsedArgv: readonly string[],
  localExtensions: readonly LocalExtensionRegistration[],
  noLaunch: boolean,
): boolean {
  if (noLaunch) return true;
  return canInvocationProvideBus(parsedArgv, localExtensions);
}

/**
 * Probe the bus health endpoint and attempt background desktop launch only
 * when the initial probe fails and the targeted command cannot provide its
 * own embedded bus.
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
 * CLI main — parse argv and dispatch.
 *
 * A single bus instance is created up-front (when the server is reachable)
 * and shared across all command registrations and handler dispatch. Discovery
 * runs in two layers:
 * 1. **Configured local discovery** — scans descriptor roots from
 *    `makaio.config.*`, an injected discovery strategy, or the default
 *    installed-extension roots. Locally-available extensions are registered via
 *    {@link registerManifestCommand} which lazy-imports the extension module at
 *    dispatch time, supporting both subcommands and interactive TUI.
 * 2. **Bus-RPC** — discovers additional commands via `cli.listContributions`.
 *    These are registered as remote commands dispatched through `cli.execute`.
 *    Commands already registered by local discovery are skipped (local wins).
 *
 * Falls back gracefully when the bus cannot be reached — locally-discovered
 * extensions remain available for `--help` while remote-only commands show a
 * connection-specific message.
 * @param argv - Process arguments (defaults to `process.argv`).
 * @param contributions - Pre-loaded contributions (for testing / DI).
 * @param discovery - Optional extension discovery strategy. Used when no
 *   explicit runtime config file is selected.
 * @param serveConfig - Host-provided configuration for the `serve` command.
 */
export async function main(
  argv: string[] = process.argv,
  contributions: ReadonlyArray<CliContribution> = [],
  discovery?: ExtensionDiscovery,
  serveConfig?: ServeConfig,
): Promise<void> {
  const {
    argv: parsedArgv,
    discovery: effectiveDiscovery,
    serveConfig: effectiveServeConfig,
    debounceFailure,
    noFailure,
    noLaunch,
  } = await resolveCliRuntimeConfig(argv, discovery, serveConfig);

  // Bare `makaio` (no subcommand, no flags) defaults to `open`.
  if (parsedArgv.length === 2) {
    parsedArgv.push('open');
  }

  const program = createProgram(effectiveServeConfig);
  const allContributions = [...BUILTIN_CLI_CONTRIBUTIONS, ...contributions];

  if (isDiscoveryFreeBuiltin(parsedArgv)) {
    await program.parseAsync(parsedArgv);
    return;
  }

  // --- Layer 1: Local filesystem discovery (pure data, no bus needed) ---
  // Injected contribution names are skipped before manifest registration, so
  // direct built-ins such as `hook` own their command action once the bus exists.
  const injectedNames = new Set(allContributions.map((c) => c.name));
  const localExtensions = await discoverLocalExtensions(program, effectiveDiscovery, injectedNames);

  // --- Single bus for the entire invocation ---
  // Resolve the bus URL once — probeHealth is a lightweight HTTP GET that gates
  // whether to attempt the heavier auto-launch + WebSocket connection path.
  // Skip the desktop launch when explicitly requested or when the targeted
  // command can embed its own bus. probeHealth still runs so an already-running
  // server can win, but timeout-sensitive hooks do not block on a launch cycle.
  const busUrl = resolveBusUrl();
  const skipLaunch = shouldSkipDesktopAutoLaunch(parsedArgv, localExtensions, noLaunch);
  const { health, backgroundLaunchAttempted } = await probeCliHealthWithOptionalLaunch(busUrl, skipLaunch);

  const { bus, connectionError } = await connectCliBus(health, {
    backgroundLaunchAttempted,
    suppressConnectionWarnings: isHelpOnlyInvocation(parsedArgv),
  });

  // Built-in supervisor client commands (registered after bus is available).
  // The client list is passed explicitly here so host client identities
  // live at the composition root, not inside the framework command module.
  registerNativeClientCommand(program, { bus, connectionError, clients: NATIVE_CLIENTS });
  registerMcpServerCommand(program, { bus, connectionError });
  registerSetupCommand(program, { bus, makaioHome: resolveMakaioHome() });

  // Pre-loaded contributions (testing/DI). Names in allContributions were
  // excluded from local discovery above, avoiding manifest placeholders that
  // would otherwise compete with direct in-process handlers such as `hook`.
  for (const contribution of allContributions) {
    registerContribution(program, contribution, bus, connectionError);
  }

  // Register locally-discovered extensions (now that the bus exists).
  for (const ext of localExtensions) {
    registerManifestCommand(program, ext.manifest, {
      cliEntryPath: ext.cliEntryPath,
      bus,
      connectionError,
      hasInteractive: ext.hasInteractive,
      importModule: ext.importModule,
    });
  }

  // --- Layer 2: Bus-RPC discovery ---
  // Fills in commands not available locally (e.g. future remote-only extensions).
  // registerRemoteCommand skips names already registered by local discovery.
  let fallback: FallbackReason = bus ? 'none' : health ? 'connection-failed' : 'unreachable';

  if (bus) {
    try {
      const { contributions: manifests } = await bus.request(CliRpcSubjects.listContributions, {});
      for (const manifest of manifests) {
        registerRemoteCommand(program, manifest, bus);
      }
    } catch (err) {
      fallback = 'discovery-failed';
      console.warn('[cli] Failed to discover commands:', err instanceof Error ? err.message : err);
    }
  }

  // When server-side discovery did not succeed, replace Commander's generic
  // "unknown command" with a message that explains *why* the command wasn't found.
  if (fallback !== 'none') {
    const helpSuffix =
      fallback === 'unreachable'
        ? `\n${connectionError ?? 'Server not running — some extension commands may be unavailable.\nStart with: makaio serve'}`
        : fallback === 'connection-failed'
          ? `\n${connectionError ?? 'The CLI could not connect to the running server.'}`
          : '\nCommand discovery failed — some extension commands may be unavailable.';
    program.addHelpText('afterAll', helpSuffix);
    applyFallbackOverrides(program);
  }

  try {
    await program.parseAsync(parsedArgv);
  } catch (err) {
    handleParseError(err, parsedArgv, fallback, connectionError, { debounceFailure, noFailure });
  } finally {
    if (bus) {
      disconnectBusSafely(bus);
    }
  }
}
