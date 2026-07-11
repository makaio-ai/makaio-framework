/**
 * Adapter definition contracts for the D2 bus-decoupled adapter subsystem.
 *
 * These interfaces define the runtime contract that adapter packages expose
 * via their {@link MakaioExtension} `adapters` contribution. They replace the
 * `definition: unknown` opaque type on {@link AdapterContribution} with a
 * typed contract that the adapter subsystem can consume directly.
 *
 * The split between manifest (serializable, bus-transportable) and definition
 * (runtime-only, contains executable code) is intentional:
 * - `AdapterManifest` — discovery-time metadata, Zod-validated, bus-safe.
 * - {@link AdapterDefinitionContract} — runtime contract with executable code.
 * @see {@link AdapterContribution} for the combined contribution type.
 */

import type { z } from 'zod';
import type { AdapterProviderAuth } from '../auth/adapter-binding.js';
import type { ProtocolId, ProviderDefinitionInput } from '../provider/definition.js';
import type { RequiredTimeoutConfig } from '../timeout/index.js';

// ---------------------------------------------------------------------------
// AdapterProviderRef
// ---------------------------------------------------------------------------

/**
 * Adapter-side declaration of a supported provider.
 *
 * The adapter declares which providers it can serve by stable definition ID.
 * The adapter subsystem resolves each ID to a full {@link ProviderDefinitionInput}
 * from the provider registry at boot. An optional config schema overrides the
 * adapter-level default for this specific provider.
 */
export interface AdapterProviderRef {
  /** Stable provider definition ID (e.g., `'anthropic'`, `'openai'`). */
  readonly definitionId: string;
  /**
   * Exact HTTP inference protocol used through this adapter/provider path.
   *
   * Omit for SDK-native or subprocess-native transports that do not consume a
   * Makaio protocol endpoint.
   */
  readonly protocol?: ProtocolId;
  /**
   * Provider-specific config schema override.
   *
   * When present, overrides any adapter-level config schema for this provider.
   */
  readonly configSchema?: z.ZodObject<z.ZodRawShape>;
  /**
   * Runtime-only compatibility, delivery, and environment-scrubbing metadata
   * for authentication methods supported through this provider path.
   */
  readonly auth?: AdapterProviderAuth;
}

// ---------------------------------------------------------------------------
// AdapterProviderDefinitionContract
// ---------------------------------------------------------------------------

/**
 * Runtime contract for a single provider supported by an adapter.
 *
 * This type is the single source of truth for the provider definition wrapper.
 * Both `ai-adapters-core/src/types/provider-definition.ts` and
 * `adapter-subsystem/src/adapter-runtime-types.ts` extend or alias this type.
 */
export interface AdapterProviderDefinitionContract {
  /**
   * Provider identity, model catalog, and endpoint declarations.
   *
   * Accepts {@link ProviderDefinitionInput} so adapter packages that declare
   * static `providerDefinition` constants can omit `availableModels` (which
   * the registry service populates at boot time). The runtime-resolved type
   * narrows after the adapter subsystem merges the registry data.
   */
  readonly definition: ProviderDefinitionInput;
  /** Exact protocol copied from the selected adapter/provider declaration. */
  readonly protocol?: ProtocolId;
  /**
   * Zod schema for provider-specific configuration fields.
   *
   * When present, the adapter subsystem uses this schema to validate and
   * expose provider configuration via the settings bus handlers.
   * Not serializable — kept in the definition, not the manifest.
   */
  readonly configSchema?: z.ZodObject<z.ZodRawShape>;
  /**
   * Validated adapter-specific authentication compatibility and delivery metadata.
   *
   * Runtime-only: the adapter subsystem resolves this from the matching
   * {@link AdapterProviderRef} and carries it alongside the provider definition.
   */
  readonly auth?: AdapterProviderAuth;
}

// ---------------------------------------------------------------------------
// AdapterDefinitionContract
// ---------------------------------------------------------------------------

/**
 * Runtime contract for an adapter contributed by an extension.
 *
 * Contains all fields needed by the `AdapterSubsystemService` to register,
 * initialize, and manage the adapter lifecycle. The generic type parameters
 * allow higher-level adapter types (e.g., `AIAdapterDefinition`) to narrow
 * both the return type of {@link createAdapter} and the options it accepts,
 * without violating TypeScript's contravariant parameter-type rules.
 *
 * This interface is not Zod-validatable because it contains functions and
 * Zod schemas as values. The serializable counterpart is `AdapterManifest`.
 * @typeParam TAdapter - Concrete adapter instance type returned by {@link createAdapter}.
 *   Defaults to `unknown` so the contract is usable without a type parameter.
 * @typeParam TOptions - Options type accepted by {@link createAdapter}.
 *   Defaults to `never` so the type-erased base contract (`AdapterContribution.definition`)
 *   is structurally compatible with any specialised definition via contravariance:
 *   `(options?: ConcreteOptions) => Promise<T>` is assignable to `(options?: never) => Promise<T>`.
 *   Specialised adapter interfaces (e.g. `AIAdapterDefinition`) pass a narrower
 *   options type here to gain compile-time safety in their factory signatures.
 */
export interface AdapterDefinitionContract<TAdapter = unknown, TOptions = never> {
  /**
   * Stable machine identifier for this adapter (e.g., `'claude-code'`).
   *
   * Must match `AdapterManifest.name` on the paired manifest entry.
   * Used as the primary key in adapter registries.
   */
  readonly name: string;
  /**
   * Human-readable display name shown in the UI (e.g., `'Claude Code'`).
   *
   * When omitted, the subsystem falls back to `AdapterManifest.displayName`.
   */
  readonly displayName?: string;
  /** Short description of what this adapter does. */
  readonly description?: string;
  /**
   * Zod schema for adapter-level configuration.
   *
   * Used by the `settings.adapter.getConfigSchema` bus handler to generate
   * JSON Schema for UI form rendering. Currently a seam — no adapter populates
   * this yet, but it is correctly placed on the definition contract for future
   * adapter-level configuration UI.
   */
  readonly adapterConfigSchema?: z.ZodObject<z.ZodRawShape>;
  /**
   * Provider IDs this adapter can serve.
   *
   * Each entry declares a provider by definition ID with optional schema
   * overrides. The adapter subsystem resolves these to full
   * {@link ProviderDefinitionInput} objects at boot from the provider registry.
   */
  readonly providers: readonly AdapterProviderRef[];
  /**
   * Default config schema applied to all providers unless overridden
   * per-provider via {@link AdapterProviderRef.configSchema}.
   */
  readonly providerConfigSchema?: z.ZodObject<z.ZodRawShape>;
  /**
   * Required timeout defaults for all adapter operations.
   *
   * The config factory should read these values instead of importing a
   * parallel constant, making this contract the single source of truth
   * for adapter timeout behavior.
   */
  readonly defaultTimeouts: RequiredTimeoutConfig;
  /**
   * External help links for this adapter (e.g., documentation, support).
   *
   * Displayed in the adapter settings UI when present.
   */
  readonly helpLinks?: ReadonlyArray<{ label: string; url: string }>;
  /**
   * Setup or usage instructions shown in the adapter configuration UI.
   *
   * May contain Markdown-formatted text.
   */
  readonly instructions?: string;
  /**
   * Identifier of the default provider preset for this adapter.
   *
   * When omitted, the runtime or user selects the preset.
   */
  readonly defaultPresetId?: string;
  /**
   * Client identifier this adapter delegates to (e.g., `'claude-code'`).
   *
   * References a `ClientManifest.id` declared on the executable
   * {@link AdapterContribution.manifest}; descriptor contributions may mirror
   * it for discovery but are not the runtime wiring source.
   */
  readonly clientId?: string;
  /**
   * Active wire protocol used by this adapter at runtime.
   *
   * This is the singular runtime-active protocol consumed by the subsystem
   * to route requests. The serializable counterpart (`AdapterManifest.protocols`)
   * may declare additional protocols for discovery-time use.
   */
  readonly protocol?: ProtocolId;
  /**
   * Factory that creates the adapter instance.
   *
   * Called by the subsystem after all configuration is resolved. The
   * `options` parameter receives merged adapter config (preset + user
   * overrides). The returned promise resolves to the typed adapter instance.
   * @param options - Resolved adapter configuration (shape defined by the adapter).
   * @returns Promise resolving to the adapter instance.
   */
  readonly createAdapter: (options?: TOptions) => Promise<TAdapter>;
}
