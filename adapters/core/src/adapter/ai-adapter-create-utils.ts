/**
 * Internal utilities for AIAdapter.createAgent() and model resolution.
 *
 * Extracted to keep ai-adapter.ts below the ESLint line-count ceiling.
 */

import type { AIModel } from '@makaio/contracts';
import type { AIAgentConfig } from '../agent/types.js';
import type { AdapterProviderDefinition } from '../types/index.js';
import { UNRESOLVED_PROVIDER_DEFINITION_ID } from '../utils/index.js';

/** Non-generic optional fields of AIAgentConfig that createAgent sets conditionally. */
export type OptionalAgentRuntimeFields = Partial<
  Pick<
    AIAgentConfig,
    | 'model'
    | 'cwd'
    | 'env'
    | 'allowedTools'
    | 'disallowedTools'
    | 'resumeAdapterSessionId'
    | 'harnessId'
    | 'clientId'
    | 'reasoningEffort'
    | 'mcpSessionContext'
    | 'toolLedger'
    | 'ephemeral'
  >
>;

/**
 * Build optional runtime fields for `AIAgentConfig` from a flat bag of candidates.
 *
 * Centralising the `...(x !== undefined && { x })` spread pattern here keeps
 * `createAgent` below the ESLint complexity ceiling while preserving
 * type-safe undefined-stripping semantics.
 *
 * Precedence: `cwd`/`env` override `platformCwd`/`platformEnv` when both are defined.
 * @param opts - Candidate optional fields; only defined values are included
 * @returns Subset of AIAgentConfig containing only the defined fields
 */
export function buildOptionalAgentConfig(
  opts: {
    platformCwd?: string;
    platformEnv?: Record<string, string>;
  } & OptionalAgentRuntimeFields,
): OptionalAgentRuntimeFields {
  return {
    ...(opts.platformCwd !== undefined && { cwd: opts.platformCwd }),
    ...(opts.platformEnv !== undefined && { env: opts.platformEnv }),
    ...(opts.model !== undefined && { model: opts.model }),
    ...(opts.cwd !== undefined && { cwd: opts.cwd }),
    ...(opts.env !== undefined && { env: opts.env }),
    ...(opts.allowedTools !== undefined && { allowedTools: opts.allowedTools }),
    ...(opts.disallowedTools !== undefined && { disallowedTools: opts.disallowedTools }),
    ...(opts.reasoningEffort !== undefined && { reasoningEffort: opts.reasoningEffort }),
    ...(opts.resumeAdapterSessionId !== undefined && { resumeAdapterSessionId: opts.resumeAdapterSessionId }),
    ...(opts.harnessId !== undefined && { harnessId: opts.harnessId }),
    ...(opts.clientId !== undefined && { clientId: opts.clientId }),
    ...(opts.mcpSessionContext !== undefined && { mcpSessionContext: opts.mcpSessionContext }),
    ...(opts.toolLedger !== undefined && { toolLedger: opts.toolLedger }),
    ...(opts.ephemeral !== undefined && { ephemeral: opts.ephemeral }),
  };
}

/**
 * Resolve execution-time model metadata for context-window lookup.
 *
 * Rules:
 * - Selected provider: use that provider's models.
 * - Single provider: use that provider's models.
 * - Multiple providers + explicit model: use provider models only when the model
 *   maps to exactly one provider.
 * - Otherwise: return undefined to avoid ambiguous cross-provider flattening.
 * @param definitionProviders - Provider definitions registered on the adapter
 * @param modelName - Explicit model name from request payload
 * @param providerDefinitionId - Provider selected by the caller's provider context
 * @returns Provider-scoped models, or undefined when ambiguous
 */
export function resolveExecutionModels(
  definitionProviders: readonly AdapterProviderDefinition[],
  modelName?: string,
  providerDefinitionId?: string,
): AIModel[] | undefined {
  if (definitionProviders.length === 0) {
    return undefined;
  }

  if (providerDefinitionId && providerDefinitionId !== UNRESOLVED_PROVIDER_DEFINITION_ID) {
    const selectedProvider = definitionProviders.find((provider) => provider.definition.id === providerDefinitionId);
    return selectedProvider?.definition.availableModels;
  }

  if (definitionProviders.length === 1) {
    return definitionProviders[0]?.definition.availableModels;
  }

  if (!modelName) {
    return undefined;
  }

  const matchingProviders = definitionProviders.filter((provider) =>
    (provider.definition.availableModels ?? []).some((model) => model.name === modelName),
  );

  if (matchingProviders.length !== 1) {
    return undefined;
  }

  return matchingProviders[0]?.definition.availableModels;
}
