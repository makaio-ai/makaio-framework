import type { ProviderContext, ProviderDefinitionInput } from '@makaio/contracts';
import type { TestModelRef } from '../types/index.js';
import { normalizeEnvValue } from './normalizeEnvValue.js';
import { createTestProviderContext } from './resolveTestConfig.js';

/** Default environment variable for selecting a conformance provider preset. */
export const MAKAIO_CONFORMANCE_PROVIDER_ENV = 'MAKAIO_CONFORMANCE_PROVIDER';

/** Default environment variable for overriding the primary conformance model. */
export const MAKAIO_CONFORMANCE_PRIMARY_MODEL_ENV = 'MAKAIO_CONFORMANCE_PRIMARY_MODEL';

/** Default environment variable for overriding the secondary conformance model. */
export const MAKAIO_CONFORMANCE_SECONDARY_MODEL_ENV = 'MAKAIO_CONFORMANCE_SECONDARY_MODEL';

/** Environment variable used by the conformance runner to pass provider definitions into worker forks. */
export const MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV = 'MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS';

/** Reads an environment variable value by name. */
export type ConformanceEnvReader = (name: string) => string | undefined;

/**
 * Options for resolving the provider/model preset used by conformance tests.
 */
export interface ResolveConformanceTestPresetOptions {
  /** Adapter name used in configuration error messages. */
  adapterName: string;
  /** Provider ID used when no env override is supplied. */
  defaultProviderId: string;
  /** Provider IDs accepted by this adapter's conformance config. */
  providerIds: readonly string[];
  /** Full provider definitions supplied by the conformance harness. */
  providerDefinitions?: readonly ProviderDefinitionInput[];
  /** Default reasoning effort to attach to resolved model refs. */
  reasoningEffort?: TestModelRef['reasoningEffort'];
  /** Environment reader, injectable for tests. */
  readEnv?: ConformanceEnvReader;
  /** Provider override env var name. */
  providerEnvVar?: string;
  /** Primary model override env var name. */
  primaryModelEnvVar?: string;
  /** Secondary model override env var name. */
  secondaryModelEnvVar?: string;
}

/**
 * Resolved conformance provider/model preset.
 */
export interface ResolvedConformanceTestPreset {
  /** Provider selected for this test run. */
  provider: ProviderDefinitionInput;
  /** All accepted provider definitions, including the selected provider. */
  providers: readonly ProviderDefinitionInput[];
  /** Provider context derived from the selected provider. */
  providerContext: ProviderContext;
  /** Fast/cheap model used by most conformance tests. */
  primaryModel: TestModelRef;
  /** Second model used by lifecycle mutation tests. */
  secondaryModel: TestModelRef;
}

/**
 * Deduplicate provider definitions while preserving first-seen order.
 * @param providers - Provider definitions to deduplicate by ID
 * @returns Unique provider definitions
 */
function uniqueProviders(providers: readonly ProviderDefinitionInput[]): ProviderDefinitionInput[] {
  const result: ProviderDefinitionInput[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    result.push(provider);
  }
  return result;
}

/**
 * Parse provider definitions from the conformance worker environment.
 * @param raw - Raw JSON environment value
 * @returns Provider definitions from the worker environment
 */
function parseEnvProviderDefinitions(raw: string | undefined): readonly ProviderDefinitionInput[] {
  const normalized = normalizeEnvValue(raw);
  if (!normalized) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV} must contain valid JSON: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV} must be a JSON array`);
  }
  for (const [index, provider] of parsed.entries()) {
    if (!provider || typeof provider !== 'object' || typeof (provider as { id?: unknown }).id !== 'string') {
      throw new Error(`${MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV}[${index}] must be a provider object with an id`);
    }
  }
  return parsed as ProviderDefinitionInput[];
}

/**
 * Resolve adapter-accepted provider definitions from the harness catalog.
 * @param adapterName - Adapter name used in error messages
 * @param providerIds - Provider IDs accepted by the adapter
 * @param providerDefinitions - Provider definition catalog supplied directly
 * @param envProviderDefinitions - Provider definition catalog supplied through env
 * @returns Provider definitions accepted by the adapter
 */
function resolveAcceptedProviders(
  adapterName: string,
  providerIds: readonly string[],
  providerDefinitions: readonly ProviderDefinitionInput[],
  envProviderDefinitions: readonly ProviderDefinitionInput[],
): ProviderDefinitionInput[] {
  const catalog = new Map<string, ProviderDefinitionInput>();
  for (const provider of [...envProviderDefinitions, ...providerDefinitions]) {
    catalog.set(provider.id, provider);
  }

  const accepted = providerIds
    .map((id) => catalog.get(id))
    .filter((provider): provider is ProviderDefinitionInput => Boolean(provider));
  const missing = providerIds.filter((id) => !catalog.has(id));
  if (missing.length > 0) {
    throw new Error(
      `[${adapterName}] Conformance provider catalog is missing provider definitions: ${missing.join(', ')}. ` +
        `Run through yarn test:conformance so provider contributions are loaded.`,
    );
  }
  return uniqueProviders(accepted);
}

/**
 * Require a resolved model name with an adapter-specific configuration error.
 * @param adapterName - Adapter name used in the error prefix
 * @param provider - Provider definition selected for conformance
 * @param field - Model role being resolved
 * @param modelName - Candidate model name
 * @param envVar - Env var that can override the missing model
 * @returns The non-empty model name
 */
function requireModelName(
  adapterName: string,
  provider: ProviderDefinitionInput,
  field: 'primary' | 'secondary',
  modelName: string | undefined,
  envVar: string,
): string {
  if (modelName) return modelName;

  const providerField = field === 'primary' ? 'fastModel/defaultModel' : 'defaultModel';
  throw new Error(
    `[${adapterName}] Provider '${provider.id}' cannot be used for conformance tests: missing ${providerField}. ` +
      `Set ${envVar} or add a model to the provider definition.`,
  );
}

/**
 * Resolve a conformance test provider preset from defaults plus MAKAIO_CONFORMANCE_* overrides.
 *
 * Provider, primary model, secondary model, credentials, and endpoint overrides
 * are resolved together so CI can swap test economics without changing local
 * OAuth/default behavior.
 * @param options - Resolver inputs and optional env variable names
 * @returns Provider/model/context preset for adapter `createTestConfig()`
 */
export function resolveConformanceTestPreset(
  options: ResolveConformanceTestPresetOptions,
): ResolvedConformanceTestPreset {
  const readEnv = options.readEnv ?? ((name) => process.env[name]);
  const providerEnvVar = options.providerEnvVar ?? MAKAIO_CONFORMANCE_PROVIDER_ENV;
  const primaryModelEnvVar = options.primaryModelEnvVar ?? MAKAIO_CONFORMANCE_PRIMARY_MODEL_ENV;
  const secondaryModelEnvVar = options.secondaryModelEnvVar ?? MAKAIO_CONFORMANCE_SECONDARY_MODEL_ENV;
  const envProviderDefinitions = parseEnvProviderDefinitions(readEnv(MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV));

  const providers = resolveAcceptedProviders(
    options.adapterName,
    options.providerIds,
    options.providerDefinitions ?? [],
    envProviderDefinitions,
  );
  const providerOverride = normalizeEnvValue(readEnv(providerEnvVar));
  const providerId = providerOverride ?? options.defaultProviderId;
  const provider = providers.find((candidate) => candidate.id === providerId);

  if (!provider) {
    const available = providers.map((candidate) => candidate.id).join(', ');
    throw new Error(
      `[${options.adapterName}] Unknown conformance provider '${providerId}' from ${providerOverride ? providerEnvVar : 'defaultProviderId'}. Available providers: ${available}`,
    );
  }

  const primaryModelName = requireModelName(
    options.adapterName,
    provider,
    'primary',
    normalizeEnvValue(readEnv(primaryModelEnvVar)) ?? provider.fastModel ?? provider.defaultModel,
    primaryModelEnvVar,
  );
  const secondaryModelName = requireModelName(
    options.adapterName,
    provider,
    'secondary',
    normalizeEnvValue(readEnv(secondaryModelEnvVar)) ?? provider.defaultModel,
    secondaryModelEnvVar,
  );

  return {
    provider,
    providers,
    providerContext: createTestProviderContext(provider, providers),
    primaryModel: {
      definitionId: provider.id,
      modelName: primaryModelName,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : undefined),
    },
    secondaryModel: {
      definitionId: provider.id,
      modelName: secondaryModelName,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : undefined),
    },
  };
}
