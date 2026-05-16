import type { ExtractSubjectPayload } from '@makaio/core';
import type { IMakaioBus } from '@makaio/bus-core';
import {
  AgentSubjects,
  type AIReasoningLevel,
  type McpRuntimeSessionContext,
  type McpSessionContext,
  type ProviderContext,
  type ReasoningLevelMap,
} from '@makaio/contracts';
import type { AIAgentConnector } from '../connector/index.js';
import type { LedgerSessionContext } from './session-tool-ledger.js';

/** Connector fields that can be overridden during runtime connector swaps. */
export interface AgentRuntimeConnectorOverrides {
  cwd: string;
  model: string;
  providerContext: ProviderContext;
  mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext;
}

/** Dependencies for runtime mutation handling. */
export interface AgentRuntimeMutationManagerConfig {
  /** Stable agent identifier. */
  agentId: string;
  /** Optional Makaio session identifier. */
  sessionId?: string;
  /** Global bus for persistence and events. */
  globalBus: IMakaioBus;
  /** Read current connector. */
  getConnector: () => AIAgentConnector;
  /** Swap connector with runtime overrides. */
  swapConnector: (configOverrides?: Partial<AgentRuntimeConnectorOverrides>) => Promise<void>;
  /** Emit cwd.changed payload. */
  emitCwdChanged: (
    payload: Omit<
      ExtractSubjectPayload<typeof AgentSubjects.cwd.changed>,
      'agentId' | 'adapterId' | 'adapterName' | 'adapterSessionId'
    >,
  ) => Promise<void>;
  /** Emit model.changed payload. */
  emitModelChanged: (
    payload: Omit<
      ExtractSubjectPayload<typeof AgentSubjects.model.changed>,
      'agentId' | 'adapterId' | 'adapterName' | 'adapterSessionId'
    >,
  ) => Promise<void>;
  /** Read the agent's current provider context for no-op detection. */
  getProviderContext: () => ProviderContext | undefined;
  /** Persist provider context changes on agent config for sequential swaps. */
  setProviderContext: (providerContext: ProviderContext) => void;
  /** Persist reasoning effort changes on agent config for sequential swaps. */
  setReasoningEffort: (reasoningEffort: AIReasoningLevel | undefined) => void;
  /** Persist MCP session context changes on agent config for sequential swaps. */
  setMcpSessionContext: (
    mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext | undefined,
  ) => void;
  /** Resolve supported reasoning levels for a model from the agent's available models. */
  resolveSupportedReasoningLevels: (model: string) => ReasoningLevelMap | undefined;
}
