/**
 * Shared types for the AI adapter module.
 *
 * Canonical home for types that cross module boundaries within the adapter
 * package (registry, rehydration, infer, and the adapter class itself).
 */
import type { ProviderKeyPublication } from './adapter-provider-key-publication.js';
import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type { AdapterNamespace } from '../factory/create-adapter-namespace.js';
import type { LogImportConfig } from '../log-importer/registry-types.js';
import type { AdapterProviderDefinition } from '../types/provider-definition.js';
import type { PlatformDefaults } from '../types/ai-adapter-init-options.js';
import type { ConfigFactoryInput } from './ai-adapter-config.js';
import type { BaseAgentConnectorConfig, AIAgentConfig } from '../agent/types.js';
import type { AIAgentConnector } from '../agent/index.js';
import type { AIAgent } from '../agent/ai-agent.js';
import type { AdapterAuthRuntimePreparer } from '../config/adapter-auth-runtime.js';
import type { ExtractSubjectPayload } from '@makaio/core';
import {
  AdapterSubjects,
  type NativeForkDirective,
  type ProviderContext,
  type SessionContext,
} from '@makaio/contracts';

/** Payload type for adapter.startAgent requests. */
export type StartAgentRequestPayload = ExtractSubjectPayload<typeof AdapterSubjects.startAgent>;

/**
 * Options for creating an agent, derived from a subset of `StartAgentRequestPayload`.
 * Used by both `handleStartAgent` and the rehydration module.
 *
 * `providerContext` is typed directly as `ProviderContext` (not via `Pick` from the
 * inferred payload type) because Zod loses the `CredentialRef` brand when it infers
 * through complex union schemas. Using the canonical TypeScript type preserves
 * the brand and ensures `resolveConnectorCredentials()` receives the correct type.
 */
export type AgentCreationOptions = Omit<
  Partial<
    Pick<
      StartAgentRequestPayload,
      | 'model'
      | 'cwd'
      | 'env'
      | 'allowedTools'
      | 'disallowedTools'
      | 'allowedDirectories'
      | 'reasoningEffort'
      | 'adapterConfig'
      | 'mode'
      | 'mcpSessionContext'
      | 'harnessId'
      | 'clientId'
      | 'clientProfileName'
      | 'providerContext'
      | 'ephemeral'
    >
  >,
  'providerContext'
> & {
  adapterSessionId?: string;
  resumeAdapterSessionId?: string;
  /**
   * The attempt's provider-key publication gate.
   *
   * Carried into the agent because the routes inside it — the identity
   * enrichment stamps on every emitted event, the movement its tracker
   * announces — are publication routes like the start's own, and every route
   * asks one gate. See {@link ProviderKeyPublication}.
   */
  providerKeyPublication?: ProviderKeyPublication;
  /** Unresolved provider context (credential refs, not plaintext). */
  providerContext?: ProviderContext;
  /**
   * Source Makaio session ID when mode is 'fork'.
   * Forwarded verbatim from the fork-mode startAgent request.
   */
  sourceSessionId?: string;
  /**
   * Provider-native source session ID when mode is 'fork'.
   * Forwarded verbatim from the fork-mode startAgent request.
   */
  sourceAdapterSessionId?: string;
  /**
   * Optional provider-native checkpoint message ID for the fork point.
   * Forwarded verbatim from the fork-mode startAgent request.
   */
  forkPointMessageId?: string;
  /**
   * Optional working directory override for the forked session.
   * Forwarded verbatim from the fork-mode startAgent request.
   */
  targetWorkingDirectory?: string;
  /**
   * Orchestrator-assembled session context carrying fork directives,
   * native-locality decisions, and other session-scoped metadata.
   *
   * Present when the session orchestrator attaches context to a startAgent
   * request (e.g. fork-mode locality evaluation).
   */
  sessionContext?: SessionContext;
  /**
   * Provider-native fork directive assembled from the startAgent fork-mode fields.
   *
   * Present when the adapter is started in fork mode and a native fork is feasible.
   * When `mode` is 'fork', `buildNativeForkDirective()` constructs this from the
   * individual fork fields above. When pre-built (e.g. from rehydration), it is
   * passed through directly.
   */
  nativeFork?: NativeForkDirective;
};

/**
 * Cumulative usage totals tracked per agent.
 *
 * Token totals (`totalInputTokens`, `totalOutputTokens`) are fully restored on
 * rehydration by summing persisted turn history, so they reflect the lifetime
 * of the session across process restarts.
 *
 * `totalCalls` is intentionally **not** restored on rehydration: it is reset to
 * zero on each process start because the historical number of API calls is not
 * stored per-turn with sufficient fidelity to reconstruct accurately (one turn
 * may represent multiple API calls for streaming or multi-step adapters).
 * Treat `totalCalls` as "calls since last process start", not a lifetime count.
 */
export interface AgentUsageTotals {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCalls: number;
}

/**
 * In-process handle for an active agent and its registry-owned session metadata.
 * @typeParam TAgent - Live agent implementation exposed to local callers
 */
export interface ActiveAgentHandle<TAgent = AIAgent> {
  /** Live agent instance with its prototype and runtime state intact. */
  readonly agent: TAgent;
  /** Makaio session ID associated with the registry entry. */
  readonly sessionId: string;
  /** Provider-specific session ID, unavailable until the provider confirms it. */
  readonly adapterSessionId: string | undefined;
}

/** Result from creating an agent runtime. */
export interface AgentRuntimeCreationResult {
  cleanup: () => void;
}

/**
 * Configuration for AIAdapter constructor.
 * @typeParam TBus - Scoped bus type for adapter-specific events
 */
export interface AIAdapterConfig<TBus extends ScopedBus<string> = ScopedBus<string>> {
  /** Unique adapter name (e.g., 'openai-node', 'claude-code'). */
  name: string;
  /** Adapter capabilities (e.g., ['streaming', 'tools', 'vision']). */
  capabilities: string[];
  /** Native tools built into the adapter (e.g., ['shell_command', 'apply_patch']). */
  nativeTools?: string[];
  /** Adapter namespace for creating scoped bus. Bus created lazily in init(). */
  namespace: AdapterNamespace;
  /** Optional pre-generated adapter ID. Defaults to UUID. */
  adapterId?: string;
  /** Optional global bus override. Defaults to MakaioBus singleton. */
  globalBus?: IMakaioBus;
  scopedBus?: TBus;
  /**
   * Optional log import configuration.
   * When enabled, the adapter will watch for external session logs and import them as Makaio events.
   */
  logImport?: LogImportConfig;
  /** Provider definitions for model lookup. Injected by runtime. */
  definitionProviders?: readonly AdapterProviderDefinition[];
  /** Client identifier for the application this adapter belongs to (e.g., 'claude-code', 'codex'). Omit for API-only adapters. */
  clientId?: string;
  /** Trusted non-serializable normalized auth preparer injected by the host. */
  prepareAuthRuntime?: AdapterAuthRuntimePreparer<TBus>;
}

/**
 * Full constructor config including factory injections.
 *
 * Replaces the inline intersection type previously used in `AIAdapter`'s
 * constructor signature.
 * @typeParam TBus - Scoped bus type for adapter-specific events
 * @typeParam TConnector - Connector type bridging to the AI SDK
 * @typeParam TAgent - Agent implementation type (must extend AIAgent)
 */
export interface AIAdapterConstructorConfig<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector>,
  // Extends the default AIAdapterConfig (TBus = ScopedBus<string>) intentionally.
  // Using AIAdapterConfig<TBus> here would narrow scopedBus to the specific TBus,
  // but all 8 adapter subclass constructors accept Partial<AIAdapterConfig> (wide type).
  // The adapter constructor narrows with `config.scopedBus as TBus` — that is the
  // intentional cast point, matching the pre-extraction behavior.
> extends AIAdapterConfig {
  /** Factory to create agent instances from config. */
  agentFactory: (agentConfig: AIAgentConfig<TBus, TConnector>) => TAgent;
  /** Config factory — transforms partial input into full adapter-specific config (includes adapterId). */
  configFactory: (input: ConfigFactoryInput<TBus>) => Promise<BaseAgentConnectorConfig<TBus> & { adapterId: string }>;
  /** Connector factory — creates connector from full config (includes adapterId). */
  connectorFactory: (
    config: BaseAgentConnectorConfig<TBus> & { adapterId: string },
  ) => TConnector | Promise<TConnector>;
  /** Platform-provided defaults (cwd, env). Injected by runtime. */
  platformDefaults?: PlatformDefaults;
  /** Provider definitions for model lookup. Injected by runtime. */
  definitionProviders?: readonly AdapterProviderDefinition[];
}
