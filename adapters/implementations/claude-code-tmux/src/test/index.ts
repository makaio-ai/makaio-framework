/**
 * Test entry point for the Claude Code tmux adapter conformance tests.
 *
 * The tmux adapter depends on Claude Code hooks for lifecycle events
 * (SessionStart, PreToolUse, PostToolUse, Stop). In the production runtime,
 * hooks are shell commands (`makaio hook received claude-code <event>`) that
 * emit on the bus via the Makaio CLI kernel. In test, those shell subprocesses
 * cannot reach the vitest worker's bus.
 *
 * This module bridges that gap:
 * 1. Starts an HTTP server in the test process ({@link startHookBridge}).
 * 2. Registers a `wiring.apply` handler that configures hooks as `curl` commands
 * POSTing to the HTTP bridge instead of running `makaio hook received`.
 * 3. The HTTP bridge re-emits hook payloads on the global MakaioBus.
 * @packageDocumentation
 */

import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  type ConformanceTestConfig,
  type CreateConformanceTestConfigOptions,
  resolveConformanceTestPreset,
  resolveTestConfig,
} from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import {
  ClaudeCodeClientSubjects,
  CLAUDE_CODE_HOOK_SESSION_START,
  CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_STOP,
  clearClaudeCodeNativeCredentialsForSession,
  handleClaudeCodeSessionConfigSetup,
} from '@makaio/client-claude-code/runtime';
import { ClientSubjects } from '@makaio/contracts/client';
import { isRecord } from '@makaio/utils';
import { ClaudeCodeTmuxConnectorNamespace, type ClaudeCodeTmuxConnectorBus } from '../namespace/index.js';
import { ADAPTER_NAME } from '../constants.js';
import { testPresetId, providerIds } from '../provider.js';
import { ClaudeCodeTmuxConfig } from '../config.js';
import { createClaudeCodeTmuxAdapter } from '../adapter.js';
import type { ClaudeCodeTmuxConnector } from '../connector.js';
import type { ClaudeCodeTmuxAgent } from '../agent.js';
import { resolveAgentContextForProject, startHookBridge, type HookBridgeHandle } from './hook-bridge.js';

/** Hook event names that require wiring for the tmux adapter lifecycle. */
const HOOK_EVENT_NAMES = [
  CLAUDE_CODE_HOOK_SESSION_START,
  CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_STOP,
] as const;

let sharedHookBridge: HookBridgeHandle | undefined;
let sharedWiringUnsub: (() => void) | undefined;
let sharedSessionConfigRoot: string | undefined;
let sharedSessionConfigUnsub: (() => void) | undefined;
let sharedSessionConfigDestroyUnsub: (() => void) | undefined;
const createdProjectDirs = new Set<string>();
let sharedTmuxServerPrepared = false;

/** Test-owned tmux server name for this Vitest worker process. */
const TEST_TMUX_SERVER_NAME = `makaio-test-${process.pid}-${process.env.VITEST_WORKER_ID ?? '0'}`;

/**
 * Build a curl command that posts the hook's stdin JSON to the bridge server.
 *
 * Claude Code pipes JSON to hook command stdin; `curl -d @-` reads it.
 * @param port - Hook bridge server port.
 * @param eventName - Claude Code hook event name.
 * @param sessionId - Claude Code session ID to embed for SessionStart hooks.
 * @returns Shell command string for `.claude/settings.json`.
 */
function buildCurlHookCommand(port: number, eventName: string, sessionId: string | undefined): string {
  const dataArg =
    eventName === CLAUDE_CODE_HOOK_SESSION_START && sessionId ? `-d '{"session_id":"${sessionId}"}'` : '-d @-';
  return `curl -s -X POST http://127.0.0.1:${port}/hook/${eventName} -H 'Content-Type: application/json' ${dataArg} || true`;
}

/**
 * Build a curl command that posts Claude Code statusline stdin to the bridge.
 * @param port - Hook bridge server port.
 * @returns Shell command string for `.claude/settings.json`.
 */
function buildCurlStatuslineCommand(port: number): string {
  return `curl -s -X POST http://127.0.0.1:${port}/statusline -H 'Content-Type: application/json' -d @- || true`;
}

/**
 * Build the `.claude/settings.json` content with curl-based hook commands.
 * @param port - Hook bridge server port.
 * @param sessionId - Claude Code session ID to embed for SessionStart hooks.
 * @param skipDangerousModePermissionPrompt - Whether to acknowledge dangerous-mode launch consent.
 * @returns Settings JSON object to write.
 */
function buildHookSettings(
  port: number,
  sessionId: string | undefined,
  skipDangerousModePermissionPrompt: boolean | undefined,
): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const eventName of HOOK_EVENT_NAMES) {
    hooks[eventName] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: buildCurlHookCommand(port, eventName, sessionId) }],
      },
    ];
  }
  return {
    hooks,
    statusLine: { type: 'command', command: buildCurlStatuslineCommand(port) },
    ...(skipDangerousModePermissionPrompt === true ? { skipDangerousModePermissionPrompt: true } : {}),
  };
}

/**
 * Resolve the current platform to the subset supported by the session config
 * setup contract.
 * @returns Platform identifier accepted by `SessionConfigSetupRequestSchema`.
 */
function resolveSessionConfigPlatform(): 'darwin' | 'linux' | 'win32' {
  const platform = os.platform();
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') {
    return platform;
  }
  throw new Error(`Claude Code tmux conformance does not support session config setup on platform '${platform}'`);
}

/**
 * Check whether a file exists without leaking file contents into test logs.
 * @param filePath - Absolute path to check.
 * @returns `true` when the path exists.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Register a `wiring.apply` handler that writes curl-based hooks directly to
 * the settings file Claude Code reads for the requested scope.
 *
 * Writes the file directly rather than using `ClaudeCodeClientSettings`
 * because that class is not exported from the client package's public API.
 * @param bridgePort - Port of the running hook bridge server.
 * @returns Unsubscribe function to remove the handler.
 */
function registerTestWiringHandler(bridgePort: number): () => void {
  return MakaioBus.on(ClaudeCodeClientSubjects.wiring.apply, async (ctx) => {
    const { projectDir, configDir, scope } = ctx.payload;
    const settingsDir =
      scope === 'user' && configDir ? configDir : projectDir ? path.join(projectDir, '.claude') : undefined;
    if (!settingsDir) {
      ctx.setResult({ applied: 0, skipped: 0 });
      return;
    }
    const settingsPath = path.join(settingsDir, 'settings.json');

    await fs.mkdir(settingsDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (isRecord(parsed)) {
        existing = parsed;
      }
    } catch {
      // File doesn't exist or is invalid — start fresh.
    }

    const adapterSessionId = projectDir ? resolveAgentContextForProject(projectDir)?.adapterSessionId : undefined;
    const hookSettings = buildHookSettings(bridgePort, adapterSessionId, ctx.payload.skipDangerousModePermissionPrompt);
    const merged = { ...existing, ...hookSettings };
    await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(
      `[claude-code-tmux:test] wired hooks settingsPath=${settingsPath} bridgePort=${bridgePort} adapterSessionId=${adapterSessionId ?? ''}`,
    );

    ctx.setResult({ applied: HOOK_EVENT_NAMES.length, skipped: 0 });
  });
}

/**
 * Ensure the worker process has one hook bridge and one wiring handler.
 *
 * Conformance creates multiple test configs in one Vitest worker. Claude Code
 * reads project-scoped `.claude/settings.json`, so per-config hook bridges race
 * by overwriting the same hook commands with different ports. A worker-scoped
 * bridge keeps hook wiring stable while session_id filtering preserves per-agent
 * correlation.
 * @returns Shared hook bridge for registering agent context.
 */
async function ensureSharedHookBridge(): Promise<HookBridgeHandle> {
  if (sharedHookBridge) {
    return sharedHookBridge;
  }
  sharedHookBridge = await startHookBridge();
  sharedWiringUnsub = registerTestWiringHandler(sharedHookBridge.port);
  return sharedHookBridge;
}

/**
 * Close the worker-scoped hook bridge.
 */
async function cleanupSharedHookBridge(): Promise<void> {
  const bridge = sharedHookBridge;
  sharedHookBridge = undefined;
  sharedWiringUnsub?.();
  sharedWiringUnsub = undefined;
  await bridge?.close();
}

/**
 * Kill the isolated tmux server used by this Vitest worker.
 *
 * The production adapter defaults to the shared `makaio` server; conformance
 * tests override it with {@link TEST_TMUX_SERVER_NAME}. Killing that whole
 * server is therefore scoped to this worker and cannot interrupt other runs.
 */
function cleanupTestTmuxServer(): void {
  try {
    execFileSync('tmux', ['-L', TEST_TMUX_SERVER_NAME, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // The server is absent when no tmux session was spawned or cleanup already ran.
  }
}

/**
 * Ensure the worker's tmux server starts empty.
 */
function ensureTestTmuxServerPrepared(): void {
  if (sharedTmuxServerPrepared) {
    return;
  }
  sharedTmuxServerPrepared = true;
  cleanupTestTmuxServer();
}

/**
 * Ensure the worker process can materialize session-scoped Claude Code config.
 *
 * Production gets this from `makaio.clients-core` plus the Claude Code runtime
 * package. Conformance runs in a single in-process bus, so the tmux test entry
 * point supplies the same contract with temp-backed directories.
 */
async function ensureSharedSessionConfig(): Promise<void> {
  if (sharedSessionConfigUnsub && sharedSessionConfigDestroyUnsub) {
    return;
  }
  sharedSessionConfigRoot ??= await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-tmux-session-config-'));
  sharedSessionConfigUnsub = MakaioBus.on(ClientSubjects.sessionConfig.create, async (ctx) => {
    const sessionDir = path.join(sharedSessionConfigRoot!, ctx.payload.clientId, 'sessions', ctx.payload.sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    const configInheritance = ctx.payload.configInheritance ?? 'auth-only';
    const setup = await handleClaudeCodeSessionConfigSetup({
      sessionDir,
      baseConfigDir: ctx.payload.baseConfigDir ?? sessionDir,
      projectDir: ctx.payload.projectDir,
      platform: resolveSessionConfigPlatform(),
      configInheritance,
    });
    const authStateExists = await fileExists(path.join(sessionDir, '.claude.json'));
    console.log(
      `[claude-code-tmux:test] session config created sessionDir=${sessionDir} configInheritance=${configInheritance} authState=${authStateExists}`,
    );
    ctx.setResult({ sessionDir, env: { ...(setup.env ?? {}), CLAUDE_CONFIG_DIR: sessionDir } });
  });
  sharedSessionConfigDestroyUnsub = MakaioBus.on(ClientSubjects.sessionConfig.destroy, async (ctx) => {
    const sessionDir = path.join(sharedSessionConfigRoot!, ctx.payload.clientId, 'sessions', ctx.payload.sessionId);
    await clearClaudeCodeNativeCredentialsForSession({ sessionDir, platform: resolveSessionConfigPlatform() });
    await fs.rm(sessionDir, { recursive: true, force: true });
    ctx.setResult({ success: true });
  });
}

/** Remove worker-scoped session config handlers and temp files. */
async function cleanupSharedSessionConfig(): Promise<void> {
  sharedSessionConfigUnsub?.();
  sharedSessionConfigUnsub = undefined;
  sharedSessionConfigDestroyUnsub?.();
  sharedSessionConfigDestroyUnsub = undefined;
  const root = sharedSessionConfigRoot;
  sharedSessionConfigRoot = undefined;
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/**
 * Resolve an isolated project directory for generic conformance runs.
 *
 * The shared conformance harness passes `os.tmpdir()` by default, but Claude Code
 * also reads project-scope `.claude/settings.json`; using the global temp dir can
 * pick up stale hook commands from previous tmux runs.
 * @param requestedCwd - Requested connector working directory, if any.
 */
async function resolveTestProjectDir(requestedCwd: string | undefined): Promise<string> {
  if (requestedCwd !== undefined && path.resolve(requestedCwd) !== path.resolve(os.tmpdir())) {
    return requestedCwd;
  }
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-tmux-project-'));
  createdProjectDirs.add(projectDir);
  console.log(`[claude-code-tmux:test] isolated project cwd=${projectDir}`);
  return projectDir;
}

/**
 * Create a test configuration for conformance testing.
 *
 * Starts the HTTP hook bridge, registers the test wiring handler, and returns
 * a `ConformanceTestConfig` with a connector factory and cleanup hook.
 * @param options - Optional provider definitions from the conformance harness.
 * @returns ConformanceTestConfig with hook bridge infrastructure.
 */
export const createTestConfig = async (
  options?: CreateConformanceTestConfigOptions,
): Promise<ConformanceTestConfig<ClaudeCodeTmuxConnectorBus, ClaudeCodeTmuxConnector, ClaudeCodeTmuxAgent>> => {
  const { scopedBus } = ClaudeCodeTmuxConnectorNamespace;
  const bus = await scopedBus();
  ensureTestTmuxServerPrepared();

  const testPreset = resolveConformanceTestPreset({
    adapterName: ADAPTER_NAME,
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  const hookBridge = await ensureSharedHookBridge();
  await ensureSharedSessionConfig();

  const { ClaudeCodeTmuxConnector } = await import('../connector.js');

  /** Native Claude session IDs used for sessionConfig.create; destroyed during cleanup. */
  const createdSessionIds: string[] = [];

  return {
    createConnector: async (connectorOptions) => {
      const cwd = await resolveTestProjectDir(connectorOptions?.cwd);
      const resolvedConfig = {
        ...resolveTestConfig(connectorOptions, bus, testPreset.provider, testPreset.providers),
        cwd,
        providerConfig: {
          tmuxServerName: TEST_TMUX_SERVER_NAME,
          ...(connectorOptions?.providerConfig ?? {}),
        },
      };

      const baseConfig = await ClaudeCodeTmuxConfig.getConfig(resolvedConfig);
      const connector = new ClaudeCodeTmuxConnector(baseConfig);
      createdSessionIds.push(connector.adapterSessionId!);

      // Register the agent context with the hook bridge so PreToolUse
      // tool approval can correlate hook events to the right agent.
      // adapterSessionId is set in the constructor (generated upfront).
      hookBridge.registerAgentContext({
        agentId: connector.getAgentId(),
        adapterId: connector.adapterId,
        adapterName: connector.getAdapterName(),
        adapterSessionId: connector.adapterSessionId!,
        projectDir: cwd,
      });

      return connector;
    },
    bus,
    registerToolApprovalHandler: (_connector, _context) => () => {},
    capabilities: {
      supportsReplace: false,
      supportsInterrupt: true,
      supportsUsageMetrics: true,
    },
    options: {
      defaultTimeout: 90_000,
      concurrency: 4,
      testConcurrency: 4,
      primaryModel: testPreset.primaryModel,
      secondaryModel: testPreset.secondaryModel,
    },
    createAdapter: async (adapterOptions) =>
      createClaudeCodeTmuxAdapter({
        ...adapterOptions,
        providerConfigDefaults: { tmuxServerName: TEST_TMUX_SERVER_NAME },
      }),
    adapterName: ADAPTER_NAME,
    testProviderContext: testPreset.providerContext,
    cleanup: async () => {
      try {
        await Promise.allSettled(
          [...new Set(createdSessionIds)].map((id) =>
            MakaioBus.requestOptional(ClientSubjects.sessionConfig.destroy, {
              clientId: 'claude-code',
              sessionId: id,
            }),
          ),
        );
      } finally {
        await cleanupSharedSessionConfig();
        await Promise.allSettled([...createdProjectDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
        createdProjectDirs.clear();
        cleanupTestTmuxServer();
        await cleanupSharedHookBridge();
      }
    },
  };
};
