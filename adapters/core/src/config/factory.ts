import { z } from 'zod';
import type { Simplify } from 'type-fest';
import type { BaseAgentConnectorConfig } from '../agent/types.js';
import { resolveTimeouts, type TrackedTimeoutConfig, type TimeoutConfig } from '@makaio/utils';
import type { AdapterProviderAuth, ProtocolId, ProviderContext } from '@makaio/contracts';
import { AdapterAuthError, bindProviderAuth, type BoundProviderAuthContext } from './resolve-adapter-auth.js';

/**
 * Adapter-level defaults that can be set by the factory.
 * Generic over TConfig to get type-safe providerConfig.
 * Excludes runtime fields (agentId, sessionId, adapterName).
 * All fields optional — model comes from provider config at runtime.
 */
export type AdapterDefaults<TConfig extends BaseAgentConnectorConfig = BaseAgentConnectorConfig> = Partial<
  Omit<TConfig, 'agentId' | 'sessionId' | 'adapterName' | 'bus'>
>;

/**
 * Options for creating an adapter config factory.
 * Captures the adapter-specific constants needed to resolve config.
 * @typeParam TConfig - The adapter's full config type for type-safe defaults
 */
export interface CreateAdapterConfigFactoryOptions<TConfig extends BaseAgentConnectorConfig> {
  /** Adapter type name (e.g., 'claude-code', 'gemini-sdk') */
  adapterName: string;
  /** Adapter-level defaults (model required, others optional including providerConfig) */
  adapterDefaults: AdapterDefaults<TConfig>;
  /**
   * Optional Zod schema for provider config validation.
   * Currently unused — pass `null`. Retained as an extension point for
   * future runtime validation of merged provider config shapes.
   */
  // Intentionally unused — retained as an extension point for future runtime
  // validation of merged provider config shapes. Pass `null` until needed.
  schema: z.ZodObject<z.ZodRawShape> | null;
  /** Adapter definition containing defaultTimeouts */
  adapterDefinition: { defaultTimeouts?: TimeoutConfig };
}

/**
 * Minimal input shape required by the factory.
 * Adapters pass their full ConfigFactoryInput which extends this.
 */
export interface AdapterConfigFactoryInput<TConfig extends BaseAgentConnectorConfig> {
  bus: TConfig extends BaseAgentConnectorConfig<infer TBus> ? TBus : never;
  agentId: string;
  adapterName: string;
  adapterId: string;
  /** Resolved refs-only provider context or the closed provider-less state. */
  providerContext: ProviderContext;
  /** Exact protocol declared by the selected adapter/provider reference. */
  providerProtocol?: ProtocolId;
  /** Adapter/provider auth metadata selected by `providerContext.definitionId`. */
  adapterProviderAuth?: AdapterProviderAuth;
  /** Other adapter/provider auth declarations contributing to the scrub union. */
  compatibleProviderAuths?: readonly AdapterProviderAuth[];
  /** Whether this adapter rejects the unresolved provider state. */
  providerContextRequired?: boolean;
  /** Runtime client identity used to validate client-owned auth methods. */
  clientId?: string;
  model?: string;
  cwd?: string;
  env?: Record<string, string>;
  providerConfig?: Partial<TConfig['providerConfig']>;
  runtimeTimeouts?: TimeoutConfig;
}

/**
 * Fields guaranteed by the factory (overrides any optional versions from input).
 */
export interface FactoryGuaranteedFields<TProviderConfig> {
  adapterName: string;
  model: string;
  cwd: string;
  timeouts: TrackedTimeoutConfig;
  providerConfig: TProviderConfig;
  /** Exact refs-only auth binding consumed once by the central runtime. */
  boundProviderAuth?: BoundProviderAuthContext;
}

/**
 * Result type: input + adapter defaults + guaranteed fields.
 * Simplify flattens the intersection for better type display.
 */
export type ConfigFactoryResult<
  TInput extends AdapterConfigFactoryInput<TConfig>,
  TConfig extends BaseAgentConnectorConfig,
  TProviderConfig = TConfig['providerConfig'],
> = Simplify<
  AdapterDefaults<TConfig> &
    Omit<TInput, 'providerConfig' | 'adapterProviderAuth' | 'compatibleProviderAuths' | 'providerContextRequired'> &
    FactoryGuaranteedFields<TProviderConfig>
>;

type AdapterConfigFactory<TConfig extends BaseAgentConnectorConfig, TProviderConfig> = {
  getConfig: <TInput extends AdapterConfigFactoryInput<TConfig>>(
    input: TInput,
  ) => Promise<ConfigFactoryResult<TInput, TConfig, TProviderConfig>>;
  /** Lazily evaluate the thunk and return adapter defaults (model, fastModel, etc.) */
  getDefaults: () => AdapterDefaults<TConfig>;
};

/* eslint max-lines-per-function: ["error", { "max": 60 }] */
/**
 * Create a standardized adapter config factory.
 *
 * Eliminates ceremony by encapsulating the common pattern:
 * 1. Bind the refs-only provider auth selection to one exact adapter declaration
 * 2. resolveTimeouts with adapter + runtime layers
 * 3. Merge providerConfigDefaults with runtime providerConfig
 *
 * The factory is pure: it does not dispatch any bus requests or resolve
 * credential refs. The central connector runtime consumes the bound result.
 *
 * Options are provided via thunk to enable lazy evaluation, avoiding circular
 * dependency issues when config.ts imports from index.ts (for adapterDefinition)
 * and adapter.ts (for adapterName).
 * @param optionsThunk - Thunk returning factory configuration options
 * @returns Factory with getConfig method
 * @example
 * ```typescript
 * export const GeminiSdkConfig = createAdapterConfigFactory<GeminiConnectorConfig>(() => ({
 *   adapterName: GeminiSdkAdapterName,
 *   adapterDefaults: { model: 'gemini-2.5-pro' },
 *   schema: null,
 *   adapterDefinition: { defaultTimeouts: DEFAULT_TIMEOUTS },
 * }));
 * ```
 */
export function createAdapterConfigFactory<
  TConfig extends BaseAgentConnectorConfig,
  TProviderConfig = TConfig['providerConfig'],
>(optionsThunk: () => CreateAdapterConfigFactoryOptions<TConfig>): AdapterConfigFactory<TConfig, TProviderConfig> {
  return {
    getDefaults: () => optionsThunk().adapterDefaults,
    getConfig: <TInput extends AdapterConfigFactoryInput<TConfig>>(input: TInput) =>
      resolveFactoryConfig<TConfig, TProviderConfig, TInput>(optionsThunk, input),
  };
}

/**
 * Resolve one adapter connector config from runtime input and factory defaults.
 * @param optionsThunk - Lazy factory defaults and adapter metadata
 * @param input - Runtime connector config input
 * @returns Fully resolved connector config with refs-only auth binding
 */
async function resolveFactoryConfig<
  TConfig extends BaseAgentConnectorConfig,
  TProviderConfig,
  TInput extends AdapterConfigFactoryInput<TConfig>,
>(
  optionsThunk: () => CreateAdapterConfigFactoryOptions<TConfig>,
  input: TInput,
): Promise<ConfigFactoryResult<TInput, TConfig, TProviderConfig>> {
  const { adapterName, adapterDefaults, adapterDefinition } = optionsThunk();
  const boundProviderAuth = bindFactoryProviderAuth(input);
  const baseUrl =
    input.providerContext.state === 'resolved' && input.providerProtocol !== undefined
      ? (input.providerContext.endpointOverrides?.[input.providerProtocol] ?? null)
      : null;
  const timeouts = resolveTimeouts([
    { layer: 'adapter', source: adapterName, config: adapterDefinition.defaultTimeouts },
    { layer: 'runtime', source: 'config.ts', config: input.runtimeTimeouts },
  ]);
  const providerConfig = {
    ...adapterDefaults.providerConfig,
    ...input.providerConfig,
    baseUrl:
      baseUrl ??
      (input.providerConfig as Record<string, unknown> | undefined)?.['baseUrl'] ??
      (adapterDefaults.providerConfig as Record<string, unknown> | undefined)?.['baseUrl'],
  } as TProviderConfig;
  const model = requireFactoryModel(input.model ?? adapterDefaults.model, adapterName, input.agentId);
  const {
    providerConfig: _providerConfig,
    adapterProviderAuth: _adapterProviderAuth,
    compatibleProviderAuths: _compatibleProviderAuths,
    providerContextRequired: _providerContextRequired,
    ...runtimeInput
  } = input;
  return {
    ...adapterDefaults,
    ...runtimeInput,
    adapterName: input.adapterName,
    model,
    cwd: input.cwd ?? adapterDefaults.cwd ?? process.cwd(),
    timeouts,
    providerConfig,
    ...(boundProviderAuth !== undefined && { boundProviderAuth }),
  };
}

/**
 * Require an explicit or default model before constructing connector config.
 * @param model - Explicit or default model candidate
 * @param adapterName - Adapter name used in the failure diagnostic
 * @param agentId - Agent identifier used in the failure diagnostic
 * @returns Non-empty resolved model identifier
 */
function requireFactoryModel(model: string | undefined, adapterName: string, agentId: string): string {
  if (model !== undefined && model.length > 0) return model;
  throw new Error(
    `No model resolved for adapter "${adapterName}" (agentId: ${agentId}). ` +
      'Provide a model explicitly or configure adapterDefaults.model.',
  );
}

/**
 * Bind a resolved provider context or reject an unresolved required context.
 * @param input - Factory input carrying provider context and adapter metadata
 * @returns Immutable refs-only binding, or undefined for a provider-less adapter
 */
function bindFactoryProviderAuth<TConfig extends BaseAgentConnectorConfig>(
  input: AdapterConfigFactoryInput<TConfig>,
): BoundProviderAuthContext | undefined {
  if (input.providerContext.state === 'unresolved') {
    if (input.providerContextRequired === true) {
      throw new AdapterAuthError(
        'provider-context-unresolved',
        'This adapter requires a resolved provider authentication context.',
      );
    }
    return undefined;
  }

  if (input.adapterProviderAuth === undefined) {
    throw new AdapterAuthError('binding-missing', 'The selected provider has no adapter authentication declaration.');
  }

  const bound = bindProviderAuth({
    auth: input.providerContext.auth,
    adapterProviderAuth: input.adapterProviderAuth,
    compatibleProviderAuths: input.compatibleProviderAuths,
  });
  if (bound.auth.method.owner === 'client' && bound.auth.method.clientId !== input.clientId) {
    throw new AdapterAuthError(
      'client-mismatch',
      'Selected authentication client does not match the adapter runtime client.',
    );
  }
  return bound;
}
