import os from 'node:os';
import type { CanUseTool, PermissionMode, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { MakaioBus } from '@makaio/bus-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import type { ResolvedToolPolicy } from '@makaio/contracts';
import { ClaudeSdkConnector } from '../connector.js';
import { ClaudeCodeConnectorNamespace } from '../namespace/index.js';
import { ClaudeCodeAdapterName } from '../constants.js';
import { createSessionAccountObservationRequester } from '../account-observation-requester.js';
import type { ClaudeAgentConfig, ClaudeSessionConfig } from '../types/index.js';

/** Caller tool lists and provider config for {@link createGateConnector}, written with Makaio tool names. */
export type GateConnectorLists = Pick<ClaudeAgentConfig, 'allowedTools' | 'disallowedTools' | 'providerConfig'>;

/** A connector prepared for gate tests, with its private seams bound. */
export interface GateConnector {
  /** The real connector. */
  readonly connector: ClaudeSdkConnector;
  /**
   * The connector's real `canUseTool` factory.
   * @param policy - Resolved tool policy the handler enforces.
   * @returns The `canUseTool` handler.
   */
  createToolApprovalHandler(policy: ResolvedToolPolicy): CanUseTool;
  /**
   * The session config the connector hands to its session on start.
   * @returns The session config `buildQueryOptions` receives in production.
   */
  buildSessionConfig(): ClaudeSessionConfig;
}

/**
 * Build a real {@link ClaudeSdkConnector} whose central tool approval request (the bus
 * round trip to `ToolApprovalService`) is replaced by `centralApproval`. The connector's
 * real `canUseTool` factory and session-config builder are exposed through `Reflect.get`;
 * both are private, so reaching them here keeps production surface unchanged.
 * @param lists - Caller allow/deny lists and provider config.
 * @param centralApproval - Stand-in for `requestToolApproval`; resolves the central answer.
 * @returns The connector and its bound seams.
 */
export async function createGateConnector(
  lists: GateConnectorLists,
  centralApproval: (...args: never[]) => Promise<unknown>,
): Promise<GateConnector> {
  const bus = await ClaudeCodeConnectorNamespace.scopedBus();
  const connector = new ClaudeSdkConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: ClaudeCodeAdapterName,
    agentId: 'agent-test',
    model: 'claude-sonnet-4-20250514',
    cwd: os.tmpdir(),
    env: {},
    clientId: claudeClientDefinition.id,
    requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
    ...lists,
  });
  Object.defineProperty(connector, 'requestToolApproval', { value: centralApproval });
  const createHandler = Reflect.get(connector, 'createToolApprovalHandler') as (
    policy: ResolvedToolPolicy,
  ) => CanUseTool;
  const buildSessionConfig = Reflect.get(connector, 'buildSessionConfig') as () => ClaudeSessionConfig;
  return {
    connector,
    createToolApprovalHandler: (policy) => createHandler.call(connector, policy),
    buildSessionConfig: () => buildSessionConfig.call(connector),
  };
}

/** Tool use id carried by {@link preToolUseInput}. */
export const PRE_TOOL_USE_ID = 'toolu-test';

/**
 * PreToolUse hook input as the Claude Code CLI sends it (keys verified live in FACT-72).
 * @param toolName - Native tool name of the call.
 * @param toolInput - Tool call input.
 * @param permissionMode - Session permission mode the CLI reports.
 * @returns The hook input.
 */
export function preToolUseInput(
  toolName: string,
  toolInput: unknown,
  permissionMode: PermissionMode = 'default',
): PreToolUseHookInput {
  return {
    session_id: 'session-test',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp',
    permission_mode: permissionMode,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: PRE_TOOL_USE_ID,
  };
}
