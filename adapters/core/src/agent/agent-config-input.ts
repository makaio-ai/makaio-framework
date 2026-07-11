import type { ScopedBus } from '@makaio/bus-core';
import type { SetRequired } from 'type-fest';
import type { AIReasoningLevel, ReasoningLevelMap, ProviderContext } from '@makaio/contracts';
import { RateLimitError, AuthenticationError, ModelUnavailableError, QuotaExceededError } from '@makaio/core';
import type { ConfigFactoryInput } from '../adapter/index.js';
import type { AIAgentConnector } from '../connector/index.js';
import { createSentinelProviderContext } from '../utils/index.js';
import type { AIModel } from '../types/ai-model.js';
import type { AgentConnectorConfigOverrides, AIAgentConfig } from './types.js';

/**
 * Extract typed error category from known Makaio error subclasses.
 * @param error - Error emitted by connector/runtime code
 * @returns Structured error category when available
 */
export function extractErrorCategory(
  error: Error,
):
  | RateLimitError['code']
  | AuthenticationError['code']
  | ModelUnavailableError['code']
  | QuotaExceededError['code']
  | undefined {
  if (
    error instanceof RateLimitError ||
    error instanceof AuthenticationError ||
    error instanceof ModelUnavailableError ||
    error instanceof QuotaExceededError
  ) {
    return error.code;
  }
  return undefined;
}

/**
 * Resolve the supported reasoning levels for a given model name.
 *
 * Centralised lookup into `availableModels` so callers do not repeat the
 * find/optional-chain pattern inline.
 * @param availableModels - Model catalog to search, or `undefined` when unknown
 * @param model - Model name to look up, or `undefined` to return `undefined`
 * @returns The `supportedReasoningLevels` map for the model, or `undefined`
 */
export function resolveSupportedReasoningLevels(
  availableModels: AIModel[] | undefined,
  model?: string,
): ReasoningLevelMap | undefined {
  if (!model) return undefined;
  return availableModels?.find((entry) => entry.name === model)?.supportedReasoningLevels;
}

/**
 * Dependencies for {@link buildConfigFactoryInput}.
 * @typeParam TBus - The scoped bus type for this adapter
 * @typeParam TConnector - The connector type the owning agent wraps
 */
export interface BuildConfigFactoryInputDeps<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
> {
  /** Normalized agent config with defaults applied. */
  config: SetRequired<AIAgentConfig<TBus, TConnector>, 'globalBus'>;
  /** Model catalog for reasoning-level lookup. */
  availableModels: AIModel[] | undefined;
  /** Effective reasoning effort (live connector value preferred over config). */
  currentReasoningEffort: AIReasoningLevel | undefined;
  /** Clear all pending tool-call correlation after an agent-fatal connector failure. */
  clearAllToolCalls: () => void;
  /** Optional field overrides (e.g., cwd, model, adapterSessionId). */
  overrides?: AgentConnectorConfigOverrides;
}

/**
 * Build config factory input from agent config with optional overrides.
 *
 * Explicitly maps AIAgentConfig fields to ConfigFactoryInput — avoids
 * accidentally forwarding adapter-only fields (capabilities, nativeTools, etc.)
 * into the factory.
 * @param deps - Config sources, lookup context, and terminal cleanup callback
 * @returns ConfigFactoryInput ready for config factory
 */
export function buildConfigFactoryInput<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>>(
  deps: BuildConfigFactoryInputDeps<TBus, TConnector>,
): ConfigFactoryInput<TBus> {
  const { config: cfg, overrides } = deps;
  // providerContext is required by ConfigFactoryInput. Priority:
  //   1. Explicit override (e.g. provider swap on model change)
  //   2. Agent config value (set by orchestrator at start time, or updated by setProviderContext)
  //   3. Sentinel fallback for rehydration and tests that bypass orchestrator provider setup
  const pendingProviderContext = overrides?.providerContext ?? cfg.providerContext;
  if (pendingProviderContext === undefined) {
    console.warn(
      `[AIAgent] No providerContext available for agent "${cfg.agentId}" — falling back to sentinel. ` +
        'This indicates the orchestrator did not populate a provider context before calling startAgent.',
    );
  }
  const providerContext: ProviderContext = pendingProviderContext ?? createSentinelProviderContext();
  return {
    bus: cfg.adapterBus,
    globalBus: cfg.globalBus,
    agentId: cfg.agentId,
    adapterId: cfg.adapterId,
    adapterName: cfg.adapterName,
    providerContext,
    model: overrides?.model ?? cfg.model,
    cwd: overrides?.cwd ?? cfg.cwd,
    env: cfg.env,
    adapterSessionId: overrides?.adapterSessionId ?? cfg.adapterSessionId,
    sessionId: cfg.sessionId,
    resumeAdapterSessionId: overrides?.resumeAdapterSessionId ?? cfg.resumeAdapterSessionId,
    reasoningEffort: deps.currentReasoningEffort,
    supportedReasoningLevels: resolveSupportedReasoningLevels(deps.availableModels, overrides?.model ?? cfg.model),
    allowedTools: cfg.allowedTools,
    disallowedTools: cfg.disallowedTools,
    allowedDirectories: cfg.allowedDirectories,
    providerConfig: cfg.adapterConfig,
    mcpSessionContext: overrides?.mcpSessionContext ?? cfg.mcpSessionContext,
    toolLedger: cfg.toolLedger,
    ...(cfg.nativeFork !== undefined && { nativeFork: cfg.nativeFork }),
    ephemeral: cfg.ephemeral,
    clientId: cfg.clientId,
    clientProfileName: cfg.clientProfileName,
    harnessId: cfg.harnessId,
    errorHandler: (_error: Error, terminate: boolean) => {
      if (terminate) deps.clearAllToolCalls();
    },
  };
}
