/**
 * Assemble one agent's config from an adapter instance and a start request.
 *
 * Its own module because it is the whole of what `AIAdapter.createAgent` does:
 * the adapter contributes the facts that are true of every agent it owns, the
 * request contributes the per-start ones, and the composition root should not
 * also be the place that spells the merge out field by field.
 * @packageDocumentation
 */
import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type { AIAgentConnector } from '../connector/index.js';
import { SessionToolLedger } from '../agent/session-tool-ledger.js';
import type { AgentTeardownArbiter } from '../agent/agent-teardown-arbiter.js';
import type { AIAgentConfig, BaseAgentConnectorConfig } from '../agent/types.js';
import type { AdapterProviderDefinition, PlatformDefaults } from '../types/index.js';
import type { AgentCreationOptions } from './types.js';
import type { ConfigFactoryInput } from './ai-adapter-config.js';
import { providerKeyIsPublishable } from './adapter-provider-key-publication.js';
import {
  buildNativeForkDirective,
  buildOptionalAgentConfig,
  resolveExecutionModels,
} from './ai-adapter-create-utils.js';
import type { AdapterAuthRuntimePreparer } from '../config/adapter-auth-runtime.js';

/** What an adapter instance contributes to every agent it creates. */
export interface AgentConfigHost<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>> {
  /** Identity the start resolved for this agent. */
  readonly agentId: string;
  /** Makaio session the agent belongs to. */
  readonly sessionId: string;
  /** Adapter instance the agent runs on. */
  readonly adapterId: string;
  /** Adapter type name. */
  readonly adapterName: string;
  /** Global bus for cross-namespace communication. */
  readonly globalBus: IMakaioBus;
  /** Scoped bus for adapter-specific events. */
  readonly adapterBus: TBus;
  /** Arbiter this instance's teardowns and connector replacements share. */
  readonly teardownArbiter: AgentTeardownArbiter;
  /** Capability tags reported by the adapter. */
  readonly capabilities: string[];
  /** Native tools built into the adapter. */
  readonly nativeTools: string[];
  /** Resolved provider definitions, including adapter-provider auth metadata. */
  readonly definitionProviders: readonly AdapterProviderDefinition[];
  /** Adapter config factory. */
  readonly configFactory: (
    input: ConfigFactoryInput<TBus>,
  ) => Promise<BaseAgentConnectorConfig<TBus> & { adapterId: string }>;
  /** Adapter connector factory. */
  readonly connectorFactory: (
    config: BaseAgentConnectorConfig<TBus> & { adapterId: string },
  ) => TConnector | Promise<TConnector>;
  /** Trusted host-local auth preparation strategy, when the host injected one. */
  readonly prepareAuthRuntime: AdapterAuthRuntimePreparer<TBus> | undefined;
  /** Platform-provided cwd/env defaults, lowest priority. */
  readonly platformDefaults: PlatformDefaults | undefined;
  /** Adapter-level client identifier, the authoritative fallback for the payload's. */
  readonly clientId: string | undefined;
}

/**
 * Merge a start request and its adapter instance into one agent config.
 * @param request - Start or rehydrate request the agent is created for
 * @param host - Facts the adapter instance contributes to every agent
 * @returns The config the adapter's agent factory is invoked with
 */
export function buildAgentConfig<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>>(
  request: AgentCreationOptions,
  host: AgentConfigHost<TBus, TConnector>,
): AIAgentConfig<TBus, TConnector> {
  // Runtime options only — mode, initialMessage and sourceSessionId must not leak
  // into an agent that outlives the request that created it.
  const { model, cwd, env, allowedTools, disallowedTools, reasoningEffort, mcpSessionContext, harnessId, ephemeral } =
    request;
  const resumeAdapterSessionId =
    request.resumeAdapterSessionId ?? (request.mode === 'resume' ? request.adapterSessionId : undefined);
  // Hoisted so the gate closure below captures the publication and not the whole
  // request: a closure that outlives the request must not be the reason the
  // request's mode, initial message and source session outlive it too.
  const providerKeyPublication = request.providerKeyPublication;
  return {
    agentId: host.agentId,
    adapterId: host.adapterId,
    adapterName: host.adapterName,
    globalBus: host.globalBus,
    adapterBus: host.adapterBus,
    teardownArbiter: host.teardownArbiter,
    capabilities: host.capabilities,
    nativeTools: host.nativeTools,
    // Provider-scoped models only — cross-provider flattening is ambiguous for metadata.
    availableModels: resolveExecutionModels(
      host.definitionProviders,
      model,
      request.providerContext?.state === 'resolved' ? request.providerContext.definitionId : undefined,
    ),
    definitionProviders: host.definitionProviders,
    configFactory: host.configFactory,
    connectorFactory: host.connectorFactory,
    ...(host.prepareAuthRuntime !== undefined && { prepareAuthRuntime: host.prepareAuthRuntime }),
    sessionId: host.sessionId,
    ...(request.providerContext !== undefined && { providerContext: request.providerContext }),
    // The attempt's publication gate, read live: the routes inside this agent
    // ask the same question its start's own routes ask, and the answer changes
    // once — when the start hands the key over.
    ...(providerKeyPublication !== undefined && {
      isProviderKeyPublishable: (): boolean => providerKeyIsPublishable(providerKeyPublication),
    }),
    ...buildOptionalAgentConfig({
      platformCwd: host.platformDefaults?.cwd,
      platformEnv: host.platformDefaults?.env,
      model,
      cwd,
      env,
      allowedTools,
      disallowedTools,
      allowedDirectories: request.allowedDirectories,
      adapterSessionId: request.adapterSessionId,
      reasoningEffort,
      adapterConfig: request.adapterConfig,
      resumeAdapterSessionId,
      harnessId,
      // The payload carries a client id; the adapter is the authoritative fallback.
      clientId: request.clientId ?? host.clientId,
      clientProfileName: request.clientProfileName,
      mcpSessionContext,
      // One ledger per agent, created only when there is MCP context to track in it.
      toolLedger: mcpSessionContext !== undefined ? new SessionToolLedger() : undefined,
      ephemeral,
      nativeFork: buildNativeForkDirective(request),
    }),
  };
}
