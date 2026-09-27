import os from 'node:os';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { MakaioBus } from '@makaio/bus-core';
import { SessionLifecycle } from '@makaio/ai-adapters-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import { toNativeToolName } from '@makaio/contracts';
import type { ToolVocabulary } from '@makaio/contracts';
import { ClaudeSdkConnector } from '../connector.js';
import { ClaudeCodeConnectorNamespace } from '../namespace/index.js';
import { ClaudeCodeAdapterName } from '../constants.js';
import { createSessionAccountObservationRequester } from '../account-observation-requester.js';
import { buildQueryOptions } from '../utils/buildQueryOptions.js';
import type { ClaudeSessionConfig } from '../types/index.js';

/** Options for {@link createToolListProbe}; tool lists use Makaio tool names. */
export interface ToolListProbeOptions {
  /** Makaio-named tool allowlist, or `undefined` when unrestricted. */
  readonly allowedTools?: readonly string[];
  /** Makaio-named tool denylist, or `undefined` when none is given. */
  readonly disallowedTools?: readonly string[];
  /**
   * Inject provider config that would bypass the gate: `queryOptions.allowedTools`
   * `['Bash', 'Read']` and `permissionMode: 'bypassPermissions'`.
   */
  readonly withBypassingProviderConfig?: boolean;
}

/** Outcome of one probed tool call through the adapter's per-call gate. */
export interface ToolListProbeGateResult {
  /** Whether the SDK was told to run the call. */
  allowed: boolean;
  /** Deny message, when denied. */
  reason?: string;
  /** Whether the central tool approval was asked for this call. */
  centralApprovalCalled: boolean;
  /** Whether the result would install persistent SDK permission rules. */
  persistsRules: boolean;
}

/** Adapter view of a resolved tool list, as consumed by the tool-list conformance suite. */
export interface ToolListProbe {
  /** Native tool vocabulary of the adapter. */
  readonly vocabulary: ToolVocabulary;
  /**
   * Translate a Makaio or MCP tool name into the adapter's native name.
   * @param makaioOrMcpName - Makaio tool name or `mcp__<server>__<tool>`.
   * @returns The native tool name.
   */
  nativeName(makaioOrMcpName: string): string;
  /** Built-in tools offered to the model (SDK `Options.tools`), `'all'` when unrestricted. */
  readonly availableBuiltIns: readonly string[] | 'all';
  /** Settings that would skip the per-call gate. */
  readonly bypass: { autoApproved: readonly string[]; permissionModeBypasses: boolean };
  /**
   * Run one tool call through the gate the SDK receives.
   * @param nativeName - Native tool name as the SDK reports it.
   * @param input - Tool call input.
   * @param approval - Central approval answer overrides for this call.
   * @returns The gate outcome.
   */
  gate(
    nativeName: string,
    input: Record<string, unknown>,
    approval?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] },
  ): Promise<ToolListProbeGateResult>;
}

/**
 * Build a tool-list probe for the Claude Agent SDK adapter.
 *
 * Constructs a real {@link ClaudeSdkConnector} whose central tool approval (the bus
 * round trip) is replaced by a counting closure that allows, then feeds the connector's
 * real `canUseTool` factory into the real `buildQueryOptions`, so the probe reads what
 * the SDK would receive.
 * @param options - Caller tool lists and provider-config switch.
 * @returns The probe.
 * @throws {@link ToolNameError} When a list entry is invalid.
 */
export async function createToolListProbe(options: ToolListProbeOptions): Promise<ToolListProbe> {
  const vocabulary: ToolVocabulary = 'claude';
  const bus = await ClaudeCodeConnectorNamespace.scopedBus();
  const lists: Pick<ClaudeSessionConfig, 'allowedTools' | 'disallowedTools' | 'providerConfig'> = {
    ...(options.allowedTools !== undefined && { allowedTools: [...options.allowedTools] }),
    ...(options.disallowedTools !== undefined && { disallowedTools: [...options.disallowedTools] }),
    ...(options.withBypassingProviderConfig === true && {
      providerConfig: { queryOptions: { allowedTools: ['Bash', 'Read'], permissionMode: 'bypassPermissions' } },
    }),
  };
  const identity = {
    bus,
    adapterId: 'adapter-probe',
    adapterName: ClaudeCodeAdapterName,
    agentId: 'agent-probe',
    model: 'claude-sonnet-4-20250514',
    cwd: os.tmpdir(),
    env: {},
  };
  const connector = new ClaudeSdkConnector({
    ...identity,
    ...lists,
    clientId: claudeClientDefinition.id,
    requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
  });
  // Mirrors the connector's session config for the fields buildQueryOptions reads.
  const sessionConfig: ClaudeSessionConfig = { ...identity, ...lists };

  let pendingApproval: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | undefined;
  let centralCalls = 0;
  const centralApproval = (): Promise<unknown> => {
    centralCalls += 1;
    return Promise.resolve({ action: 'allow', ...pendingApproval });
  };
  Object.defineProperty(connector, 'requestToolApproval', { value: centralApproval });
  const createHandler = Reflect.get(connector, 'createToolApprovalHandler') as () => CanUseTool;

  const lifecycle = new SessionLifecycle();
  const queryOptions = buildQueryOptions({
    config: sessionConfig,
    lifecycle,
    createToolApprovalHandler: () => createHandler.call(connector),
    sessionId: 'session-probe',
  });
  const { canUseTool } = queryOptions;
  if (canUseTool === undefined) throw new Error('buildQueryOptions produced no canUseTool gate');

  return {
    vocabulary,
    nativeName: (name) => toNativeToolName(vocabulary, name),
    availableBuiltIns: queryOptions.tools === undefined ? 'all' : (queryOptions.tools as readonly string[]),
    bypass: {
      autoApproved: queryOptions.allowedTools ?? [],
      permissionModeBypasses: queryOptions.permissionMode !== undefined && queryOptions.permissionMode !== 'default',
    },
    async gate(nativeName, input, approval) {
      pendingApproval = approval;
      const before = centralCalls;
      try {
        const result = await canUseTool(nativeName, input, {
          signal: new AbortController().signal,
          toolUseID: `tool-use-${nativeName}`,
        } as Parameters<CanUseTool>[2]);
        return result.behavior === 'allow'
          ? {
              allowed: true,
              centralApprovalCalled: centralCalls > before,
              persistsRules: result.updatedPermissions !== undefined,
            }
          : {
              allowed: false,
              reason: result.message,
              centralApprovalCalled: centralCalls > before,
              persistsRules: false,
            };
      } finally {
        pendingApproval = undefined;
      }
    },
  };
}
