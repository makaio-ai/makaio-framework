/**
 * Permission request types extracted from SDK.
 * These are not exported by the SDK but are used in callback signatures.
 */
import type {
  SessionEvent,
  PermissionRequest,
  PermissionRequestResult,
  SessionConfig,
  CopilotClient,
} from '@github/copilot-sdk';
import { BaseAgentConnectorConfig, MessageHandle, type ISessionToolLedger } from '@makaio/ai-adapters-core';
import type { ScopedBus } from '@makaio/bus-core';
import { CopilotSessionEvent, GitHubCopilotConnectorBus } from '../namespaces';
import type { GitHubCopilotSdkProviderSettings } from '../schemas.js';

/**
 * GitHub Copilot adapter namespace identifier.
 */
export const GITHUB_COPILOT_NAMESPACE = 'adapter:github-copilot' as const;

/**
 * Scoped bus type for GitHub Copilot adapter.
 */
export type GitHubCopilotBusType = ScopedBus<typeof GITHUB_COPILOT_NAMESPACE>;

// Re-export SDK permission types for external use
export type SdkPermissionRequest = PermissionRequest;
export type SdkPermissionRequestResult = PermissionRequestResult;

/**
 * Provider-specific configuration for the GitHub Copilot SDK connector.
 *
 * Contains only non-credential settings. Authentication is supplied separately
 * through the connector-local normalized runtime snapshot.
 */
export type GitHubCopilotProviderConfig = GitHubCopilotSdkProviderSettings;

/**
 * Configuration for a GitHub Copilot connector session.
 * Extends BaseAgentConnectorConfig with Copilot-specific options.
 */
export type CopilotSessionOptions = BaseAgentConnectorConfig<GitHubCopilotBusType, GitHubCopilotProviderConfig>;

export interface ConsumptionCompleteResult {
  error?: Error;
  lastEvent?: SessionEvent | null;
}

export type GitHubCopilotAgentConnectorConfig = CopilotSessionOptions;

export type GitHubCopilotModel = {
  id: string;
  name: string;
  capabilities: {
    supports: {
      vision: boolean;
    };
    limits: {
      max_prompt_tokens?: number;
      max_context_window_tokens: number;
      vision?: {
        supported_media_types: string[];
        max_prompt_images: number;
        max_prompt_image_size: number;
      };
    };
  };
  policy?: {
    state: 'enabled' | 'disabled' | 'unconfigured';
    terms: string;
  };
  billing?: {
    multiplier: number;
  };
};

/**
 * Configuration for CopilotConnectorSession.
 */
export interface CopilotSessionConfig {
  bus: GitHubCopilotConnectorBus;
  adapterId: string;
  adapterName: string;
  agentId: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
  /** Session config for creating sessions via CopilotClient */
  sessionConfig: SessionConfig;
  /** CopilotClient instance for SDK lifecycle management */
  client: CopilotClient;
  emitSdkEvent: (event: CopilotSessionEvent) => Promise<void>;
  handleError: (error: Error, terminate: boolean) => void;
  onTurnStart?: (handle: MessageHandle) => void;
  onTurnComplete?: (handle: MessageHandle, result: { outcome: string; result?: unknown; error?: unknown }) => void;
  /** Session tool ledger used for MCP call tracking. */
  toolLedger?: ISessionToolLedger;
  /** Current turn number supplier for MCP ledger bookkeeping. */
  getCurrentTurnNumber?: () => number;
}
