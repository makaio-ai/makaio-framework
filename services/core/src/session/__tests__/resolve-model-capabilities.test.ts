/**
 * Tests for the `resolveModelCapabilities` utility.
 *
 * Verifies that the function correctly resolves model capabilities from the
 * provider catalog via the bus, handles missing data gracefully, and treats
 * bus errors as soft failures.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { AIModel } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '../../adapter-subsystem/namespace.js';
import { ProviderStorageSubjects } from '../../settings/storage/providers-namespace.js';
import type { ProviderConfigFileRecord } from '../../adapter-subsystem/schemas.js';
import { resolveModelCapabilities } from '../utils/resolution.js';
import { resetBusHandlers } from '../testing/orchestrator-shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UnsubscribeFunction = () => void;

// ---------------------------------------------------------------------------
// Shared test fixture data
// ---------------------------------------------------------------------------

const PROVIDER_CONFIG_ID = 'provider-config-uuid';
const DEFINITION_ID = 'anthropic';
const MODEL_NAME = 'claude-opus-4';

const REASONING_LEVELS = {
  none: 0,
  low: 1024,
  medium: 4096,
  high: 8192,
} as const;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('resolveModelCapabilities', () => {
  let unsubscribers: UnsubscribeFunction[] = [];

  afterEach(() => {
    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers = [];
  });

  // Initialise per-test (not beforeEach) so each test can configure its own
  // handlers without relying on `beforeEach` ordering.
  function setup(): void {
    resetBusHandlers();
    unsubscribers = [];
  }

  /**
   * Registers an `AdapterSubsystemSubjects.getProviderConfig` handler that
   * returns a standard Anthropic config record, optionally merged with
   * `overrides`.
   * @param overrides - Partial fields to override on the default config record.
   */
  function registerProviderConfigHandler(overrides?: Partial<ProviderConfigFileRecord>): void {
    unsubscribers.push(
      MakaioBus.on(AdapterSubsystemSubjects.getProviderConfig, (ctx) => {
        ctx.setResult({
          config: {
            id: ctx.payload.id,
            definitionId: DEFINITION_ID,
            name: 'Anthropic Config',
            auth: {
              mode: 'none',
              method: { owner: 'provider', providerDefinitionId: DEFINITION_ID, methodId: 'none' },
              hasCredentials: false,
            },
            modelFilterMode: 'show-all',
            isDefault: true,
            enabled: true,
            ...overrides,
          },
        });
      }),
    );
  }

  /**
   * Registers a `ProviderStorageSubjects.get` handler that returns an
   * Anthropic provider record with the given `availableModels`.
   * @param availableModels - The model catalog to include in the provider record.
   */
  function registerProviderCatalogHandler(availableModels: AIModel[]): void {
    unsubscribers.push(
      MakaioBus.on(ProviderStorageSubjects.get, (ctx) => {
        ctx.setResult({
          provider: {
            id: ctx.payload.id,
            packageName: '@makaio/provider-anthropic',
            name: 'Anthropic',
            availableModels,
            authMethods: [],
            defaultModelFilterMode: 'show-all',
            enabled: true,
            createdAt: 0,
            updatedAt: 0,
          },
        });
      }),
    );
  }

  it('returns undefined immediately when providerId is undefined', async () => {
    setup();

    // No bus handlers needed — the function should short-circuit before any call.
    const result = await resolveModelCapabilities(MakaioBus, undefined, MODEL_NAME);

    expect(result).toBeUndefined();
  });

  it('returns undefined immediately when model is undefined', async () => {
    setup();

    const result = await resolveModelCapabilities(MakaioBus, PROVIDER_CONFIG_ID, undefined);

    expect(result).toBeUndefined();
  });

  it('returns supportedReasoningLevels when model is found in the provider catalog', async () => {
    setup();
    registerProviderConfigHandler();
    registerProviderCatalogHandler([
      {
        name: MODEL_NAME,
        contextWindowSize: 200_000,
        labId: DEFINITION_ID,
        supportedReasoningLevels: REASONING_LEVELS,
      },
    ]);

    const result = await resolveModelCapabilities(MakaioBus, PROVIDER_CONFIG_ID, MODEL_NAME);

    expect(result).toEqual({ supportedReasoningLevels: REASONING_LEVELS });
  });

  it('returns undefined when model is not found in the provider catalog', async () => {
    setup();
    registerProviderConfigHandler();
    // Catalog does NOT include `MODEL_NAME`
    registerProviderCatalogHandler([{ name: 'claude-haiku', contextWindowSize: 200_000, labId: DEFINITION_ID }]);

    const result = await resolveModelCapabilities(MakaioBus, PROVIDER_CONFIG_ID, MODEL_NAME);

    expect(result).toBeUndefined();
  });

  it('returns undefined when provider config is not found (config: null)', async () => {
    setup();

    unsubscribers.push(
      MakaioBus.on(AdapterSubsystemSubjects.getProviderConfig, (ctx) => {
        ctx.setResult({ config: null });
      }),
    );

    const result = await resolveModelCapabilities(MakaioBus, PROVIDER_CONFIG_ID, MODEL_NAME);

    expect(result).toBeUndefined();
  });

  it('returns undefined on bus error (soft failure)', async () => {
    setup();

    unsubscribers.push(
      MakaioBus.on(AdapterSubsystemSubjects.getProviderConfig, () => {
        throw new Error('Storage unavailable');
      }),
    );

    // Must not throw — capability resolution is best-effort.
    const result = await resolveModelCapabilities(MakaioBus, PROVIDER_CONFIG_ID, MODEL_NAME);

    expect(result).toBeUndefined();
  });
});
