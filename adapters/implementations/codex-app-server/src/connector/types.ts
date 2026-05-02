/**
 * Codex App-Server Connector types.
 * @packageDocumentation
 */

import type { ISessionToolLedger, MessageHandle } from '@makaio/ai-adapters-core';
import type { AIReasoningLevel, ProviderContext } from '@makaio/contracts';
import type { StdioTransport } from '../utils/createStdioTransport.js';
import type { JsonRpcClient } from '../utils/jsonRpcClient.js';
import type { CodexAppServerBus } from '../namespaces/index.js';

/**
 * Client info for JSON-RPC initialize handshake.
 */
export const CLIENT_INFO = {
  name: 'makaio-codex-app-server',
  title: 'Makaio Codex App-Server',
  version: '0.1.0',
} as const;

/**
 * Approval policy options.
 */
export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

/**
 * Sandbox mode options.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * Reasoning effort accepted by the CodexAppServerConnector configuration.
 *
 * Widened to the canonical {@link AIReasoningLevel} type so the connector
 * accepts values from the profile/persona layer without an extra narrowing step.
 * `'none'` means "omit the effort field entirely" — the connector maps it to `null`
 * in the `turn/start` protocol message rather than passing the string literal.
 */
export type ReasoningEffort = AIReasoningLevel;

/**
 * Configuration for CodexAppServerConnector.
 * Extends BaseAgentConnectorConfig with app-server specific options.
 */
export interface CodexAppServerConfig {
  bus: CodexAppServerBus;
  adapterId: string;
  adapterName: string;
  agentId: string;
  model: string;
  cwd: string;
  env?: Record<string, string>;
  /**
   * Unresolved provider context (credential refs, not plaintext).
   * Connectors resolve credentials locally via `resolveConnectorCredentials()`.
   */
  providerContext?: ProviderContext;
  /** Approval policy per AskForApproval protocol type */
  approvalPolicy?: ApprovalPolicy;
  /** Sandbox mode per SandboxMode protocol type */
  sandboxMode?: SandboxMode;
  reasoningEffort?: ReasoningEffort;
  errorHandler?: (error: Error, terminate: boolean) => void;
  onMessageSent?: (handle: MessageHandle) => void;
  /** Session tool ledger for MCP call tracking. */
  toolLedger?: ISessionToolLedger;
  /** Client identifier for the application this adapter belongs to (e.g., 'codex'). */
  clientId?: string;
  /** Resolved harness ID for tool policy lookup. */
  harnessId?: string;
  /** Optional transport for dependency injection (e.g., testing) */
  transport?: StdioTransport;
  /** Optional JSON-RPC client for dependency injection (e.g., testing). If provided, transport is ignored. */
  jsonRpcClient?: JsonRpcClient;
}
