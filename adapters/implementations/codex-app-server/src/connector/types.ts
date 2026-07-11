/**
 * Codex App-Server Connector types.
 * @packageDocumentation
 */

import type { BaseAgentConnectorConfig } from '@makaio/ai-adapters-core';
import type { AIReasoningLevel } from '@makaio/contracts';
import type { StdioTransport } from '../utils/createStdioTransport.js';
import type { JsonRpcClient } from '../utils/jsonRpcClient.js';
import type { CodexAppServerBus } from '../namespaces/index.js';
import type { CodexAppServerProviderConfig } from '../schemas.js';

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
export interface CodexAppServerConfig
  extends BaseAgentConnectorConfig<CodexAppServerBus, CodexAppServerProviderConfig> {
  /** Runtime adapter identity required by connector construction. */
  adapterId: string;
  /** Approval policy per AskForApproval protocol type */
  approvalPolicy?: ApprovalPolicy;
  /** Sandbox mode per SandboxMode protocol type */
  sandboxMode?: SandboxMode;
  /** Optional transport for dependency injection (e.g., testing) */
  transport?: StdioTransport;
  /** Optional JSON-RPC client for dependency injection (e.g., testing). If provided, transport is ignored. */
  jsonRpcClient?: JsonRpcClient;
}
