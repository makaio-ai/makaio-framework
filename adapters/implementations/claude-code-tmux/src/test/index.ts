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
import { startHookBridge, type HookBridgeHandle } from './hook-bridge.js';

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

/**
 * Build a curl command that posts the hook's stdin JSON to the bridge server.
 *
 * Claude Code pipes JSON to hook command stdin; `curl -d @-` reads it.
 * @param port - Hook bridge server port.
 * @param eventName - Claude Code hook event name.
 * @returns Shell command string for `.claude/settings.json`.
 */
function buildCurlHookCommand(port: number, eventName: string): string {
  return `curl -s -X POST http://127.0.0.1:${port}/hook/${eventName} -H 'Content-Type: application/json' -d @- || true`;
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
 * @returns Settings JSON object to write.
 */
function buildHookSettings(port: number): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const eventName of HOOK_EVENT_NAMES) {
    hooks[eventName] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: buildCurlHookCommand(port, eventName) }],
      },
    ];
  }
  return { hooks, statusLine: { type: 'command', command: buildCurlStatuslineCommand(port) } };
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

    const hookSettings = buildHookSettings(bridgePort);
    const merged = { ...existing, ...hookSettings };
    await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');

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

  const testPreset = resolveConformanceTestPreset({
    adapterName: ADAPTER_NAME,
    defaultProviderId: testPresetId,
    providerIds,
    providerDefinitions: options?.providerDefinitions,
    reasoningEffort: 'low',
  });

  const hookBridge = await ensureSharedHookBridge();

  const { ClaudeCodeTmuxConnector } = await import('../connector.js');

  /** Session IDs created via sessionConfig.create; destroyed during cleanup. */
  const createdSessionIds: string[] = [];

  return {
    createConnector: async (connectorOptions) => {
      const resolvedConfig = resolveTestConfig(connectorOptions, bus, testPreset.provider, testPreset.providers);

      // Determine the session ID the connector will use for config isolation
      // (mirrors the connector's own logic: sessionId ?? agentId). Track it
      // so the session config directory is destroyed during cleanup even when
      // the connector's own teardown is skipped.
      const sessionId = connectorOptions?.sessionId ?? resolvedConfig.agentId;
      createdSessionIds.push(sessionId);

      const baseConfig = await ClaudeCodeTmuxConfig.getConfig(resolvedConfig);
      const connector = new ClaudeCodeTmuxConnector(baseConfig);

      // Register the agent context with the hook bridge so PreToolUse
      // tool approval can correlate hook events to the right agent.
      // adapterSessionId is set in the constructor (generated upfront).
      hookBridge.registerAgentContext({
        agentId: connector.getAgentId(),
        adapterId: connector.adapterId,
        adapterName: connector.getAdapterName(),
        adapterSessionId: connector.adapterSessionId!,
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
    createAdapter: async (adapterOptions) => createClaudeCodeTmuxAdapter(adapterOptions),
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
        await cleanupSharedHookBridge();
      }
    },
  };
};
