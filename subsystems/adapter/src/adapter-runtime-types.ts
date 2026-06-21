import type { IMakaioBus } from '@makaio/bus-core';
import type {
  ProtocolId,
  AdapterClientRef,
  AdapterProviderDefinitionContract,
  AdapterProviderRef,
} from '@makaio/contracts';
import type { HelpLink } from '@makaio/services-core/settings';
import type { z } from 'zod';

/**
 * Minimal log import configuration surface needed by adapter lifecycle utilities.
 *
 * Mirrors the shape of `LogImportConfig` from `@makaio/ai-adapters-core` without
 * taking a dependency on the host-layer package.
 */
export interface AdapterLogImportConfig {
  /** Whether log import is enabled. */
  enabled: boolean;
  /** Polling interval for the file watcher in milliseconds. */
  pollIntervalMs?: number;
  /** Maximum events to emit per second (rate limiting). */
  eventsPerSecond?: number;
}

/**
 * Initialization options surface needed by adapter lifecycle utilities.
 *
 * Captures the fields from `AIAdapterInitOptions` (host layer) that are
 * required by the adapter lifecycle utilities in this package. Fields that
 * carry host-layer types (e.g. `platformDefaults`) are represented as
 * `unknown` so callers can pass the full host object without the core
 * package depending on the host layer.
 */
export interface AdapterInitOptions {
  /** Per-adapter unique identifier assigned by the runtime. */
  adapterId?: string;
  /**
   * Platform-provided defaults (cwd, env, etc.).
   * Typed as `unknown` to avoid importing from the host layer.
   */
  platformDefaults?: unknown;
  /** Log import configuration for external session imports. */
  logImport?: AdapterLogImportConfig;
  /** Provider definitions from the adapter definition. */
  definitionProviders?: AdapterProviderDefinitionContract[];
  /** Default model when not specified per-message. */
  defaultModel?: string;
  /** Provider-specific config. */
  providerOptions?: unknown;
  /**
   * Runtime-selected client identifier.
   *
   * This is an initialization override used by client-backed adapter factories.
   * Adapter compatibility is declared separately on {@link LoadedAdapter.clients}.
   * Omit for API-only adapters.
   */
  clientId?: string;
  /**
   * Global bus instance for cross-adapter communication.
   *
   * When provided, the adapter registers its RPC handlers (e.g. `adapter.startAgent`)
   * on this bus instead of falling back to the `MakaioBus` singleton. Required for
   * downstream consumers where the runtime bus differs from the default singleton.
   */
  globalBus?: IMakaioBus;
}

/**
 * Minimal adapter instance surface returned by the adapter factory.
 *
 * Captures the `adapterId` field needed by the runtime to validate instance
 * identity after initialization.
 */
export interface AdapterInstance {
  /** Unique identifier assigned when the adapter instance is created. */
  adapterId?: string;
}

/**
 * Provider definition resolved for one loaded adapter.
 */
export interface LoadedAdapterProvider extends AdapterProviderDefinitionContract {
  /** Extension package that contributed the provider definition. */
  providerPackageName: string;
}

/**
 * Loaded adapter entry produced by processing `MakaioPackage.adapters`.
 *
 * This is the canonical core-layer representation of a fully-loaded adapter
 * definition, decoupled from the host-layer `AIAdapterDefinition` type.
 * It carries everything the runtime needs to initialize, route, and manage
 * adapter lifecycle.
 */
export interface LoadedAdapter {
  /** Internal adapter driver name (e.g. `'claude-code'`). */
  name: string;
  /** Human-readable display name for UI. */
  displayName?: string;
  /** Short description for tooltips/selection UI. */
  description?: string;
  /** NPM package name the adapter was loaded from. */
  packageName: string;
  /**
   * Factory function that creates a live adapter instance.
   *
   * The parameter is typed as `unknown` because the full option shape
   * (`AIAdapterInitOptions`) lives in the host layer. The core layer
   * forwards the options object without inspecting it, so the loose type
   * avoids a contravariant incompatibility at the core/host boundary.
   * @param options - Initialization options forwarded by the runtime
   * @returns Promise resolving to a live adapter instance
   */
  factory: (options?: unknown) => Promise<AdapterInstance>;
  /** Runtime initialization options merged from config and defaults. */
  options: AdapterInitOptions;
  /** Adapter-wide config schema (runtime-only, for adapter-level settings). */
  adapterConfigSchema?: z.ZodObject<z.ZodRawShape>;
  /**
   * Provider definition IDs declared by the adapter, including definitions whose
   * provider extensions are not active yet.
   */
  providerDefinitionIds: readonly string[];
  /** Adapter provider references, including schema overrides, used for delayed provider resolution. */
  providerRefs: readonly AdapterProviderRef[];
  /**
   * Provider definitions with presets and per-provider schemas.
   *
   * Uses `AdapterProviderDefinitionContract` from `@makaio/contracts` as the
   * single-source provider definition wrapper. The host-layer
   * `AdapterProviderDefinition` (from `ai-adapters-core`) extends this
   * contract and is assignment-compatible.
   */
  providers: LoadedAdapterProvider[];
  /** Adapter-level provider config schema applied during delayed provider resolution. */
  providerConfigSchema?: z.ZodObject<z.ZodRawShape>;
  /** Adapter-level provider credential schema applied during delayed provider resolution. */
  providerCredentialSchema?: z.ZodObject<z.ZodRawShape>;
  /** Help links for documentation. */
  helpLinks?: readonly HelpLink[];
  /** Setup instructions in Markdown format. */
  instructions?: string;
  /** Default preset to use when no provider is explicitly configured. */
  defaultPresetId?: string;
  /** Client extensions this adapter can delegate to, with compatible version ranges. */
  clients?: readonly AdapterClientRef[];
  /** Wire protocol this adapter speaks (e.g., `'anthropic'`, `'openai'`). */
  protocol?: ProtocolId;
}
