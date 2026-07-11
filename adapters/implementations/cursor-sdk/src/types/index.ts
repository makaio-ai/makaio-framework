import type { BaseAgentConnectorConfig } from '@makaio/ai-adapters-core';
import type { CursorSdkBus } from '../namespaces/index.js';
import type { CursorSdkProviderConfig } from '../schemas.js';

/** Stable bus namespace identifier for the Cursor SDK adapter. */
export const CURSOR_SDK_NAMESPACE = 'adapter:cursorSdk' as const;

/**
 * Cursor SDK connector configuration.
 *
 * Extends {@link BaseAgentConnectorConfig} with the Cursor-specific scoped bus and
 * provider config. The `providerConfig` field is typed to `CursorSdkProviderConfig`
 * rather than using the generic parameter so this type is structurally
 * assignable from the factory-provided `BaseAgentConnectorConfig<CursorSdkBus> & { adapterId: string }`.
 * `cwd` and `model` are inherited from `BaseAgentConnectorConfig`.
 */
export type CursorConnectorConfig = Omit<BaseAgentConnectorConfig<CursorSdkBus>, 'providerConfig'> & {
  /** Persisted adapter instance ID. */
  adapterId: string;
  /** Provider-specific configuration. */
  providerConfig?: CursorSdkProviderConfig;
};

/**
 * Session initialization configuration for the Cursor SDK adapter.
 *
 * Carries the identity and runtime context needed to create a Cursor agent
 * session and register it with the MCP bridge.
 */
export interface CursorSessionConfig {
  /** Makaio agent ID. */
  agentId: string;
  /** Persisted adapter ID. */
  adapterId: string;
  /** Adapter name constant. */
  adapterName: string;
  /** Makaio session ID. */
  makaioSessionId?: string;
  /** Working directory for the Cursor agent. */
  cwd: string;
  /** Auth-free environment forwarded to the MCP bridge context. */
  contextEnv?: Readonly<Record<string, string>>;
  /** Model to use for the session. */
  model: string;
  /** API key for Cursor SDK authentication. */
  apiKey: string;
  /** System prompt passed to Agent.create(). */
  systemPrompt?: string;
  /** Provider-specific Cursor SDK options. */
  providerConfig?: CursorSdkProviderConfig;
}
