import type { IMakaioBus } from '@makaio/bus-core';
import type {
  ProtocolId,
  AdapterClientRef,
  AdapterProviderDefinitionContract,
  AdapterProviderRef,
  ConnectorTeardownResult,
} from '@makaio/contracts';
import type { HelpLink } from '@makaio/services-core/settings';
import type { ClientDefinition } from '@makaio/contracts/client';
import type { z } from 'zod';
import type { AdapterInstanceTeardownResult } from './adapter-instance-teardown.js';

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
  /**
   * Trusted host-layer auth preparer forwarded opaquely to the adapter factory.
   *
   * The core subsystem never invokes or serializes this value, avoiding a
   * dependency on the host adapter runtime types.
   */
  prepareAuthRuntime?: unknown;
}

/**
 * Runtime identity injected immediately before the adapter factory is called.
 *
 * Stored adapter options intentionally exclude these values: the active
 * authority incarnation changes across runtime lifetimes and must never be
 * captured in contribution-time configuration.
 */
export interface AdapterRuntimeInitOptions extends AdapterInitOptions {
  /** Per-adapter unique identifier assigned by the runtime. */
  adapterId: string;
  /** Session-ownership authority incarnation hosting this adapter. */
  ownerInstanceId: string;
  /** Stable machine identity hosting this adapter runtime. */
  machineId: string;
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
  /** Preferred awaitable shutdown hook, which may report actual teardown evidence. */
  closeAsync?: () => void | ConnectorTeardownResult | Promise<void | ConnectorTeardownResult>;
  /** Legacy shutdown hook, which may report actual teardown evidence. */
  shutdown?: () => void | ConnectorTeardownResult | Promise<void | ConnectorTeardownResult>;
  /** Fire-and-forget compatible shutdown hook, which may report actual teardown evidence. */
  close?: () => void | ConnectorTeardownResult | Promise<void | ConnectorTeardownResult>;
}

/** One in-flight retirement that still owns close and lifecycle-publication observation. */
export interface AdapterRuntimeRetirementFlight {
  /** Settles only after the close hook and deinitialization observation have finished. */
  readonly completion: Promise<AdapterInstanceTeardownResult>;
  /** Settles when the bounded retirement attempt has reported its evidence. */
  readonly cancellationCompletion: Promise<void>;
}

/** One adapter-runtime slot, either dispatchable or awaiting proven retirement. */
export type AdapterRuntimeEntry =
  | {
      /** The instance is currently eligible for local routing. */
      readonly state: 'live';
      /** Adapter handle exposed to local dispatch. */
      readonly instance: AdapterInstance;
      /** Ownership-authority incarnation captured during construction. */
      readonly ownerInstanceId: string;
    }
  | {
      /** Routing was withdrawn, but the previous handle has not proved it stopped. */
      readonly state: 'retiring';
      /** Handle retained so a later lifecycle attempt can retry close. */
      readonly instance: AdapterInstance;
      /** Ownership-authority incarnation captured during construction. */
      readonly ownerInstanceId: string;
      /** Weak evidence reported by the most recent retirement attempt. */
      readonly report: ConnectorTeardownResult;
      /** Active close/publication flight that must finish before another retry. */
      readonly flight?: AdapterRuntimeRetirementFlight;
    };

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
   * This core-layer runtime shape carries the authority and machine identities
   * required by every live adapter. Host-specific fields stay opaque where the
   * core layer does not need to inspect them.
   * @param options - Initialization options forwarded by the runtime
   * @returns Promise resolving to a live adapter instance
   */
  factory: (options: AdapterRuntimeInitOptions) => Promise<AdapterInstance>;
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
  /** Help links for documentation. */
  helpLinks?: readonly HelpLink[];
  /** Setup instructions in Markdown format. */
  instructions?: string;
  /** Default preset to use when no provider is explicitly configured. */
  defaultPresetId?: string;
  /** Client extensions this adapter can delegate to, with compatible version ranges. */
  clients?: readonly AdapterClientRef[];
  /** Authoritative definitions for every client this adapter may execute. */
  clientDefinitions?: readonly ClientDefinition[];
  /** Wire protocol this adapter speaks (e.g., `'anthropic'`, `'openai'`). */
  protocol?: ProtocolId;
}
