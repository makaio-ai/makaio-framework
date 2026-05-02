import { z } from 'zod';
import type { Simplify } from 'type-fest';
import type { BaseAgentConnectorConfig } from '../agent/types.js';
import { resolveTimeouts, type TrackedTimeoutConfig, type TimeoutConfig } from '@makaio/utils';
import type { ProtocolId, ProviderContext } from '@makaio/contracts';

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
  /** Wire protocol used to select the correct provider endpoint URL from endpointOverrides. */
  protocol: ProtocolId;
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
  /**
   * Unresolved provider context (credential refs, not plaintext).
   * Connectors resolve credentials locally via `resolveConnectorCredentials()`.
   */
  providerContext: ProviderContext;
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
}

/**
 * Result type: input + adapter defaults + guaranteed fields.
 * Simplify flattens the intersection for better type display.
 */
export type ConfigFactoryResult<
  TInput extends AdapterConfigFactoryInput<TConfig>,
  TConfig extends BaseAgentConnectorConfig,
  TProviderConfig = TConfig['providerConfig'],
> = Simplify<AdapterDefaults<TConfig> & Omit<TInput, 'providerConfig'> & FactoryGuaranteedFields<TProviderConfig>>;

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
 * 1. Read unresolved providerContext (credential refs only — no plaintext on the bus)
 * 2. resolveTimeouts with adapter + runtime layers
 * 3. Merge providerConfigDefaults with runtime providerConfig (credentials resolved by connector)
 *
 * The factory is pure: it does not dispatch any bus requests and does not
 * resolve credentials. Connectors call `resolveConnectorCredentials()` locally.
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
 *   protocol: 'openai',
 * }));
 * ```
 */
export function createAdapterConfigFactory<
  TConfig extends BaseAgentConnectorConfig,
  TProviderConfig = TConfig['providerConfig'],
>(optionsThunk: () => CreateAdapterConfigFactoryOptions<TConfig>): AdapterConfigFactory<TConfig, TProviderConfig> {
  return {
    getDefaults: () => optionsThunk().adapterDefaults,
    getConfig: async <TInput extends AdapterConfigFactoryInput<TConfig>>(input: TInput) => {
      const { adapterName, adapterDefaults, adapterDefinition, protocol } = optionsThunk();

      // 1. Read unresolved provider context — credentials are NOT spread here.
      //    Connectors call resolveConnectorCredentials() locally at connection time.
      const { providerContext } = input;
      const baseUrl = providerContext.endpointOverrides?.[protocol] ?? null;

      // 2. Resolve timeouts
      const timeouts = resolveTimeouts([
        { layer: 'adapter', source: adapterName, config: adapterDefinition.defaultTimeouts },
        { layer: 'runtime', source: 'config.ts', config: input.runtimeTimeouts },
      ]);

      // 3. Build provider config: adapter defaults < runtime overrides < baseUrl
      //    Credentials are intentionally absent — connectors resolve them locally.
      const providerConfig = {
        ...adapterDefaults.providerConfig,
        ...input.providerConfig,
        baseUrl:
          baseUrl ??
          (input.providerConfig as Record<string, unknown> | undefined)?.['baseUrl'] ??
          (adapterDefaults.providerConfig as Record<string, unknown> | undefined)?.['baseUrl'],
      } as TProviderConfig;

      // 4. Build result
      const model = input.model ?? adapterDefaults.model;
      if (!model) {
        throw new Error(
          `No model resolved for adapter "${adapterName}" (agentId: ${input.agentId}). ` +
            'Provide a model explicitly or configure adapterDefaults.model.',
        );
      }

      const result: ConfigFactoryResult<TInput, TConfig, TProviderConfig> = {
        ...adapterDefaults,
        ...input,
        adapterName: input.adapterName,
        model,
        cwd: input.cwd ?? adapterDefaults.cwd ?? process.cwd(),
        timeouts,
        providerConfig,
      };
      return result;
    },
  };
}
