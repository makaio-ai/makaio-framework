/**
 * Internal utilities for AIAdapter.createAgent() and model resolution.
 *
 * Extracted to keep ai-adapter.ts below the ESLint line-count ceiling.
 */

import {
  SessionContextSchema,
  type AdapterProviderAuth,
  type AIModel,
  type NativeForkDirective,
  type ProtocolId,
  type ProviderContext,
} from '@makaio/contracts';
import type { AIAgentConfig } from '../agent/types.js';
import type { AgentCreationOptions } from './types.js';
import type { AdapterProviderDefinition } from '../types/index.js';

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
 * Resolve authentication metadata for the provider selected by a provider context.
 *
 * Selection is definition-ID exact. It deliberately does not use the single-provider
 * or model-name fallbacks used for display metadata because auth delivery must never
 * be inferred from an ambiguous provider selection.
 * @param definitionProviders - Provider definitions registered on the adapter
 * @param providerDefinitionId - Definition ID selected by the effective provider context
 * @returns Matching adapter-provider auth metadata, or undefined when none is declared
 */
export function resolveAdapterProviderAuth(
  definitionProviders: readonly AdapterProviderDefinition[] | undefined,
  providerDefinitionId: string,
): AdapterProviderAuth | undefined {
  return definitionProviders?.find((provider) => provider.definition.id === providerDefinitionId)?.auth;
}

/**
 * Resolve the exact HTTP protocol declared for one adapter/provider path.
 * @param definitionProviders - Provider definitions registered on the adapter
 * @param providerDefinitionId - Definition ID selected by the provider context
 * @returns Selected protocol, or undefined for SDK-native transports
 */
export function resolveAdapterProviderProtocol(
  definitionProviders: readonly AdapterProviderDefinition[] | undefined,
  providerDefinitionId: string,
): ProtocolId | undefined {
  return definitionProviders?.find((provider) => provider.definition.id === providerDefinitionId)?.protocol;
}

/**
 * Resolve all other adapter/provider auth declarations that contribute to the
 * adapter-wide environment scrub set.
 * @param definitionProviders - Provider definitions registered on the adapter
 * @param selectedProviderDefinitionId - Definition selected for this connector
 * @returns Compatible auth declarations in adapter definition order
 */
export function resolveCompatibleAdapterProviderAuths(
  definitionProviders: readonly AdapterProviderDefinition[] | undefined,
  selectedProviderDefinitionId: string,
): AdapterProviderAuth[] {
  return (
    definitionProviders?.flatMap((provider) =>
      provider.definition.id !== selectedProviderDefinitionId && provider.auth !== undefined ? [provider.auth] : [],
    ) ?? []
  );
}

/** Adapter metadata selected by one canonical provider context. */
export interface AdapterProviderSelection {
  /** Exact transport protocol, when the adapter/provider path declares one. */
  readonly providerProtocol?: ProtocolId;
  /** Exact selected authentication delivery declaration. */
  readonly adapterProviderAuth?: AdapterProviderAuth;
  /** Other compatible declarations contributing to ambient env scrubbing. */
  readonly compatibleProviderAuths: readonly AdapterProviderAuth[];
}

/**
 * Resolve protocol and auth metadata for one canonical provider context.
 * @param definitionProviders - Provider definitions registered on the adapter
 * @param providerContext - Canonical refs-only provider execution context
 * @returns Exact adapter metadata, or an empty selection for provider-less execution
 */
export function resolveAdapterProviderSelection(
  definitionProviders: readonly AdapterProviderDefinition[] | undefined,
  providerContext: ProviderContext,
): AdapterProviderSelection {
  if (providerContext.state === 'unresolved') {
    return { compatibleProviderAuths: [] };
  }
  return {
    providerProtocol: resolveAdapterProviderProtocol(definitionProviders, providerContext.definitionId),
    adapterProviderAuth: resolveAdapterProviderAuth(definitionProviders, providerContext.definitionId),
    compatibleProviderAuths: resolveCompatibleAdapterProviderAuths(definitionProviders, providerContext.definitionId),
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

  if (providerDefinitionId) {
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
