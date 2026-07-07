/**
 * Internal utilities for AIAdapter.createAgent() and model resolution.
 *
 * Extracted to keep ai-adapter.ts below the ESLint line-count ceiling.
 */

import { SessionContextSchema, type AIModel, type NativeForkDirective } from '@makaio/contracts';
import type { AIAgentConfig } from '../agent/types.js';
import type { AgentCreationOptions } from './types.js';
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
    | 'allowedDirectories'
    | 'adapterSessionId'
    | 'resumeAdapterSessionId'
    | 'harnessId'
    | 'clientId'
    | 'clientProfileName'
    | 'reasoningEffort'
    | 'adapterConfig'
    | 'mcpSessionContext'
    | 'toolLedger'
    | 'ephemeral'
    | 'nativeFork'
  >
>;

/**
 * Build optional runtime fields for `AIAgentConfig` from a flat bag of candidates.
 *
 * Centralising the undefined-stripping spread pattern here keeps `createAgent` below
 * the ESLint complexity ceiling while preserving type-safe semantics.
 *
 * Precedence: `cwd` overrides `platformCwd`; `env` is merged over `platformEnv` key-by-key.
 * @param opts - Candidate optional fields; only defined values are included
 * @returns Subset of AIAgentConfig containing only the defined fields
 */
export function buildOptionalAgentConfig(
  opts: {
    platformCwd?: string;
    platformEnv?: Record<string, string>;
  } & OptionalAgentRuntimeFields,
): OptionalAgentRuntimeFields {
  const env =
    opts.platformEnv !== undefined || opts.env !== undefined ? { ...opts.platformEnv, ...opts.env } : undefined;
  // Strip undefined values. Object.entries + filter avoids per-field conditionals that
  // inflate ESLint complexity. Fields retain their original keys from the opts object.
  const direct = stripUndefined({
    model: opts.model,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    allowedDirectories: opts.allowedDirectories,
    adapterSessionId: opts.adapterSessionId,
    resumeAdapterSessionId: opts.resumeAdapterSessionId,
    reasoningEffort: opts.reasoningEffort,
    adapterConfig: opts.adapterConfig,
    harnessId: opts.harnessId,
    clientId: opts.clientId,
    clientProfileName: opts.clientProfileName,
    mcpSessionContext: opts.mcpSessionContext,
    toolLedger: opts.toolLedger,
    ephemeral: opts.ephemeral,
    nativeFork: opts.nativeFork,
  });
  return {
    ...(opts.platformCwd !== undefined && { cwd: opts.platformCwd }),
    ...(env !== undefined && { env }),
    ...(opts.cwd !== undefined && { cwd: opts.cwd }),
    ...direct,
  };
}

/**
 * Return a shallow copy of `obj` with all `undefined` values removed.
 * Used to keep `buildOptionalAgentConfig` below ESLint's complexity ceiling.
 * @param obj - Plain object whose undefined entries should be dropped
 * @returns New object with only defined values
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
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

/**
 * Build the provider-native fork directive from orchestrator-approved context.
 *
 * Raw fork-mode request fields identify what the caller asked for. They are not
 * proof that a provider-native branch is safe on this machine. The session
 * orchestrator evaluates locality and structural constraints, then reflects the
 * approved provider directive as `sessionContext.nativeFork` only when
 * `sessionContext.nativeLocality.kind === 'native'`.
 * @param request - Agent creation options from the startAgent pipeline
 * @returns Approved fork directive, or undefined when native fork is not approved
 */
export function buildNativeForkDirective(request: AgentCreationOptions): NativeForkDirective | undefined {
  if (request.mode !== 'fork') {
    return undefined;
  }
  const sessionContext = request.sessionContext;
  const parsedSessionContext = sessionContext !== undefined ? SessionContextSchema.parse(sessionContext) : undefined;
  if (parsedSessionContext?.nativeLocality?.kind !== 'native') {
    return undefined;
  }
  return parsedSessionContext.nativeFork;
}
