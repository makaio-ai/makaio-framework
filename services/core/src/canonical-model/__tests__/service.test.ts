import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import { CanonicalModelSubjects, type ProviderDefinition, type ResolvableCanonicalModel } from '@makaio/contracts';
import {
  AdapterSubsystemSubjects,
  type BindingRecord as AdapterSubsystemBindingRecord,
  type EffectiveAdapter,
  type ProviderConfigFileRecord,
} from '../../adapter-subsystem/index.js';
import { ModelRegistrySubjects } from '../../model-registry/index.js';
import { CanonicalModelService } from '../canonical-model-service.js';
import type { CanonicalModelResolutionError } from '../errors.js';
import { makeDefinition, makeModel } from './fixtures.js';

let cleanups: Array<() => void> = [];
let service: CanonicalModelService;
let adapterSubsystemReadyCalls = 0;

const on: typeof MakaioBus.on = (...args: Parameters<typeof MakaioBus.on>) => {
  const unsub = (MakaioBus.on as typeof MakaioBus.on)(...args);
  cleanups.push(unsub);
  return unsub;
};

beforeEach(async () => {
  MakaioBus.__resetHandlers?.();
  cleanups = [];
  adapterSubsystemReadyCalls = 0;
  on(AdapterSubsystemSubjects.ensureReady, (ctx) => {
    adapterSubsystemReadyCalls += 1;
    ctx.setResult({ ready: true });
  });
  service = new CanonicalModelService(MakaioBus);
  await service.init();
});

afterEach(async () => {
  await service.destroy();
  for (const cleanup of cleanups) {
    cleanup();
  }
  cleanups = [];
  MakaioBus.__resetHandlers?.();
});

describe('CanonicalModelService', () => {
  it('waits for the adapter subsystem to be ready before wiring resolver handlers', () => {
    expect(adapterSubsystemReadyCalls).toBe(1);
  });

  it('resolves adapter segments through the adapter-subsystem default binding', async () => {
    on(AdapterSubsystemSubjects.listAdapters, (ctx) => {
      ctx.setResult({
        adapters: [
          makeEffectiveAdapter({ name: 'anthropic-sdk', displayName: 'Anthropic SDK', enabled: true }),
          makeEffectiveAdapter({ name: 'openai-node', displayName: 'OpenAI Node', enabled: false }),
        ],
      });
    });
    on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
      expect(ctx.payload).toEqual({ enabled: true });
      ctx.setResult({
        configs: [makeProviderConfigRecord({ id: 'cfg-default', name: 'Anthropic Default' })],
      });
    });
    on(AdapterSubsystemSubjects.getDefaultBinding, (ctx) => {
      ctx.setResult({
        binding: makeSubsystemBinding({ adapterName: ctx.payload.adapterName, providerConfigId: 'cfg-default' }),
      });
    });

    const result = await MakaioBus.request(CanonicalModelSubjects.resolve, {
      parsed: {
        kind: 'qualified',
        segment1: 'anthropic-sdk',
        model: 'claude-sonnet-4-5',
      } satisfies ResolvableCanonicalModel,
    });

    expect(adapterSubsystemReadyCalls).toBe(1);
    expect(result).toMatchObject({
      kind: 'adapter',
      adapterName: 'anthropic-sdk',
      providerConfigId: 'cfg-default',
      model: 'claude-sonnet-4-5',
    });
  });

  it('does not resolve an adapter through a disabled default binding', async () => {
    on(AdapterSubsystemSubjects.listAdapters, (ctx) => {
      ctx.setResult({
        adapters: [makeEffectiveAdapter({ name: 'anthropic-sdk', displayName: 'Anthropic SDK', enabled: true })],
      });
    });
    on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
      expect(ctx.payload).toEqual({ enabled: true });
      ctx.setResult({
        configs: [makeProviderConfigRecord({ id: 'cfg-enabled', name: 'Anthropic Enabled' })],
      });
    });
    on(AdapterSubsystemSubjects.getDefaultBinding, (ctx) => {
      ctx.setResult({
        binding: makeSubsystemBinding({
          adapterName: 'anthropic-sdk',
          providerConfigId: 'cfg-disabled',
        }),
      });
    });
    on(AdapterSubsystemSubjects.listBindings, (ctx) => {
      expect(ctx.payload).toEqual({ adapterName: 'anthropic-sdk' });
      ctx.setResult({
        bindings: [
          makeSubsystemBinding({
            adapterName: 'anthropic-sdk',
            providerConfigId: 'cfg-disabled',
            isDefault: true,
          }),
          makeSubsystemBinding({
            adapterName: 'anthropic-sdk',
            providerConfigId: 'cfg-enabled',
            isDefault: false,
          }),
        ],
      });
    });

    const result = await MakaioBus.request(CanonicalModelSubjects.resolve, {
      parsed: {
        kind: 'qualified',
        segment1: 'anthropic-sdk',
        model: 'claude-sonnet-4-5',
      } satisfies ResolvableCanonicalModel,
    });

    expect(result).toMatchObject({
      kind: 'adapter',
      adapterName: 'anthropic-sdk',
      providerConfigId: 'cfg-enabled',
      model: 'claude-sonnet-4-5',
    });
  });

  it('matches provider config names case-insensitively', async () => {
    on(AdapterSubsystemSubjects.listAdapters, (ctx) => {
      ctx.setResult({
        adapters: [makeEffectiveAdapter({ name: 'anthropic-sdk', displayName: 'Anthropic SDK', enabled: true })],
      });
    });
    on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
      expect(ctx.payload).toEqual({ enabled: true });
      ctx.setResult({
        configs: [
          makeProviderConfigRecord({ id: 'cfg-work', name: 'Anthropic Work' }),
          makeProviderConfigRecord({ id: 'cfg-disabled', name: 'Anthropic Disabled', enabled: false }),
        ],
      });
    });
    on(AdapterSubsystemSubjects.listBindingsByConfig, (ctx) => {
      expect(ctx.payload).toEqual({ providerConfigId: 'cfg-work' });
      ctx.setResult({
        bindings: [makeSubsystemBinding({ adapterName: 'anthropic-sdk', providerConfigId: 'cfg-work' })],
      });
    });

    const result = await MakaioBus.request(CanonicalModelSubjects.resolve, {
      parsed: {
        kind: 'qualified',
        segment1: 'anthropic-work',
        model: 'claude-sonnet-4-5',
      } satisfies ResolvableCanonicalModel,
    });

    expect(result).toMatchObject({
      kind: 'adapter',
      adapterName: 'anthropic-sdk',
      providerConfigId: 'cfg-work',
      model: 'claude-sonnet-4-5',
    });
  });

  it('finds provider definitions by scanning enabled adapter registries', async () => {
    const defA = makeDefinition({ id: 'def-a', name: 'Provider A' });
    const defB = makeDefinition({ id: 'def-b', name: 'Provider B' });
    const definitionsByAdapter: Record<string, ProviderDefinition[]> = {
      'adapter-1': [defA],
      'adapter-2': [defB],
    };
    let listAdaptersCalls = 0;

    on(AdapterSubsystemSubjects.listAdapters, (ctx) => {
      listAdaptersCalls += 1;
      ctx.setResult({
        adapters: [
          makeEffectiveAdapter({ name: 'adapter-1', displayName: 'Adapter 1', enabled: true }),
          makeEffectiveAdapter({ name: 'adapter-2', displayName: 'Adapter 2', enabled: true }),
        ],
      });
    });
    on(AdapterSubsystemSubjects.getProviderDefinitionsByAdapter, (ctx) => {
      ctx.setResult({ definitions: definitionsByAdapter[ctx.payload.adapterName] ?? [] });
    });
    on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
      expect(ctx.payload).toEqual({ enabled: true });
      ctx.setResult({ configs: [] });
    });
    on(AdapterSubsystemSubjects.listProviderConfigsByDefinition, (ctx) => {
      expect(ctx.payload).toEqual({ definitionId: 'def-b' });
      ctx.setResult({
        configs:
          ctx.payload.definitionId === 'def-b'
            ? [makeProviderConfigRecord({ id: 'cfg-b', definitionId: 'def-b' })]
            : [],
      });
    });
    on(AdapterSubsystemSubjects.listBindingsByConfig, (ctx) => {
      expect(ctx.payload).toEqual({ providerConfigId: 'cfg-b' });
      ctx.setResult({
        bindings:
          ctx.payload.providerConfigId === 'cfg-b'
            ? [makeSubsystemBinding({ adapterName: 'adapter-2', providerConfigId: 'cfg-b' })]
            : [],
      });
    });

    const result = await MakaioBus.request(CanonicalModelSubjects.resolve, {
      parsed: { kind: 'qualified', segment1: 'def-b', model: 'some-model' } satisfies ResolvableCanonicalModel,
    });

    expect(listAdaptersCalls).toBe(1);
    expect(result).toMatchObject({ kind: 'adapter', adapterName: 'adapter-2', providerConfigId: 'cfg-b' });
  });

  it('resolves bare models via the default chain and surfaces ambiguity', async () => {
    const definitionA: ProviderDefinition = makeDefinition({
      id: 'def-a',
      availableModels: [makeModel('shared-model')],
    });
    const definitionB: ProviderDefinition = makeDefinition({
      id: 'def-b',
      availableModels: [makeModel('shared-model')],
    });

    on(AdapterSubsystemSubjects.listAdapters, (ctx) => {
      ctx.setResult({
        adapters: [
          makeEffectiveAdapter({ name: 'adapter-a', displayName: 'Adapter A', enabled: true }),
          makeEffectiveAdapter({ name: 'adapter-b', displayName: 'Adapter B', enabled: true }),
        ],
      });
    });
    on(AdapterSubsystemSubjects.getProviderDefinitionsByAdapter, (ctx) => {
      ctx.setResult({
        definitions:
          ctx.payload.adapterName === 'adapter-a'
            ? [definitionA]
            : ctx.payload.adapterName === 'adapter-b'
              ? [definitionB]
              : [],
      });
    });
    on(ModelRegistrySubjects.checkModelInProviders, (ctx) => {
      const matchingIds = ctx.payload.providerIds.filter((id) => id === 'def-a' || id === 'def-b');
      const matches = Object.fromEntries(matchingIds.map((id) => [id, makeModel(ctx.payload.model)]));
      ctx.setResult({ matches });
    });
    on(AdapterSubsystemSubjects.findConfigForDefinitionAndAdapter, (ctx) => {
      ctx.setResult({
        config:
          ctx.payload.definitionId === 'def-a'
            ? makeProviderConfigRecord({ id: 'cfg-a', definitionId: 'def-a' })
            : ctx.payload.definitionId === 'def-b'
              ? makeProviderConfigRecord({ id: 'cfg-b', definitionId: 'def-b' })
              : null,
      });
    });

    const error = await MakaioBus.request(CanonicalModelSubjects.resolve, {
      parsed: { kind: 'bare', model: 'shared-model' } satisfies ResolvableCanonicalModel,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestError);
    expect(((error as RequestError).cause as CanonicalModelResolutionError).code).toBe('ambiguous-model');
  });

  it('treats the same provider definition on different adapters as ambiguous bare-model routes', async () => {
    const sharedDefinition: ProviderDefinition = makeDefinition({
      id: 'def-shared',
      availableModels: [makeModel('shared-model')],
    });

    on(AdapterSubsystemSubjects.listAdapters, (ctx) => {
      ctx.setResult({
        adapters: [
          makeEffectiveAdapter({ name: 'adapter-a', displayName: 'Adapter A', enabled: true }),
          makeEffectiveAdapter({ name: 'adapter-b', displayName: 'Adapter B', enabled: true }),
        ],
      });
    });
    on(AdapterSubsystemSubjects.getProviderDefinitionsByAdapter, (ctx) => {
      ctx.setResult({
        definitions:
          ctx.payload.adapterName === 'adapter-a' || ctx.payload.adapterName === 'adapter-b' ? [sharedDefinition] : [],
      });
    });
    on(ModelRegistrySubjects.checkModelInProviders, (ctx) => {
      expect(ctx.payload.providerIds).toEqual(['def-shared']);
      expect(ctx.payload.model).toBe('shared-model');
      ctx.setResult({ matches: { 'def-shared': makeModel(ctx.payload.model) } });
    });
    on(AdapterSubsystemSubjects.findConfigForDefinitionAndAdapter, (ctx) => {
      expect(ctx.payload.definitionId).toBe('def-shared');
      ctx.setResult({
        config:
          ctx.payload.adapterName === 'adapter-a'
            ? makeProviderConfigRecord({ id: 'cfg-a', definitionId: 'def-shared' })
            : ctx.payload.adapterName === 'adapter-b'
              ? makeProviderConfigRecord({ id: 'cfg-b', definitionId: 'def-shared' })
              : null,
      });
    });

    const error = await MakaioBus.request(CanonicalModelSubjects.resolve, {
      parsed: { kind: 'bare', model: 'shared-model' } satisfies ResolvableCanonicalModel,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestError);
    const cause = (error as RequestError).cause as CanonicalModelResolutionError;
    expect(cause.code).toBe('ambiguous-model');
    expect(cause.suggestions).toEqual(['adapter-a/def-shared::shared-model', 'adapter-b/def-shared::shared-model']);
  });

  it('looks up provider configs for one adapter concurrently after registry matching', async () => {
    let inFlightConfigLookups = 0;
    let maxInFlightConfigLookups = 0;
    const definitions = [
      makeDefinition({ id: 'def-a', availableModels: [makeModel('shared-model')] }),
      makeDefinition({ id: 'def-b', availableModels: [makeModel('shared-model')] }),
    ];

    on(AdapterSubsystemSubjects.listAdapters, (ctx) => {
      ctx.setResult({
        adapters: [makeEffectiveAdapter({ name: 'adapter-a', displayName: 'Adapter A', enabled: true })],
      });
    });
    on(AdapterSubsystemSubjects.getProviderDefinitionsByAdapter, (ctx) => {
      expect(ctx.payload.adapterName).toBe('adapter-a');
      ctx.setResult({ definitions });
    });
    on(ModelRegistrySubjects.checkModelInProviders, (ctx) => {
      ctx.setResult({
        matches: Object.fromEntries(ctx.payload.providerIds.map((id) => [id, makeModel(ctx.payload.model)])),
      });
    });
    on(AdapterSubsystemSubjects.findConfigForDefinitionAndAdapter, async (ctx) => {
      inFlightConfigLookups += 1;
      maxInFlightConfigLookups = Math.max(maxInFlightConfigLookups, inFlightConfigLookups);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlightConfigLookups -= 1;
      ctx.setResult({
        config: makeProviderConfigRecord({
          id: `cfg-${ctx.payload.definitionId}`,
          definitionId: ctx.payload.definitionId,
        }),
      });
    });

    await MakaioBus.request(CanonicalModelSubjects.resolve, {
      parsed: { kind: 'bare', model: 'shared-model' } satisfies ResolvableCanonicalModel,
    }).catch(() => undefined);

    expect(maxInFlightConfigLookups).toBe(2);
  });

  it('returns not-found for bare models absent from every enabled adapter registry', async () => {
    on(AdapterSubsystemSubjects.listAdapters, (ctx) => {
      ctx.setResult({
        adapters: [makeEffectiveAdapter({ name: 'adapter-a', displayName: 'Adapter A', enabled: true })],
      });
    });
    on(AdapterSubsystemSubjects.getProviderDefinitionsByAdapter, (ctx) => {
      expect(ctx.payload).toEqual({ adapterName: 'adapter-a' });
      ctx.setResult({ definitions: [makeDefinition({ id: 'def-a', availableModels: [makeModel('other')] })] });
    });
    on(ModelRegistrySubjects.checkModelInProviders, (ctx) => {
      expect(ctx.payload.providerIds).toContain('def-a');
      expect(ctx.payload.model).toBe('missing-model');
      ctx.setResult({ matches: {} });
    });

    const error = await MakaioBus.request(CanonicalModelSubjects.resolve, {
      parsed: { kind: 'bare', model: 'missing-model' } satisfies ResolvableCanonicalModel,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RequestError);
    expect(((error as RequestError).cause as CanonicalModelResolutionError).code).toBe('model-not-found');
  });

  it('resolves provider config slugs produced from whitespace-collapsed names', async () => {
    on(AdapterSubsystemSubjects.listAdapters, (ctx) => {
      ctx.setResult({
        adapters: [makeEffectiveAdapter({ name: 'anthropic-sdk', displayName: 'Anthropic SDK', enabled: true })],
      });
    });
    on(AdapterSubsystemSubjects.listProviderConfigs, (ctx) => {
      ctx.setResult({
        configs: [makeProviderConfigRecord({ id: 'cfg-work', name: 'My Work Account' })],
      });
    });
    on(AdapterSubsystemSubjects.listBindingsByConfig, (ctx) => {
      expect(ctx.payload).toEqual({ providerConfigId: 'cfg-work' });
      ctx.setResult({
        bindings: [makeSubsystemBinding({ adapterName: 'anthropic-sdk', providerConfigId: 'cfg-work' })],
      });
    });

    const result = await MakaioBus.request(CanonicalModelSubjects.resolve, {
      parsed: {
        kind: 'qualified',
        segment1: 'my-work-account',
        model: 'claude-haiku',
      } satisfies ResolvableCanonicalModel,
    });

    expect(result).toEqual({
      kind: 'adapter',
      adapterName: 'anthropic-sdk',
      providerConfigId: 'cfg-work',
      model: 'claude-haiku',
    });
  });
});

/**
 * Build a minimal adapter-subsystem binding record for tests.
 * @param overrides - Field overrides
 * @returns Binding record
 */
function makeSubsystemBinding(overrides: Partial<AdapterSubsystemBindingRecord> = {}): AdapterSubsystemBindingRecord {
  return {
    adapterName: 'anthropic-sdk',
    providerConfigId: 'config-1',
    isDefault: true,
    ...overrides,
  };
}

/**
 * Build a minimal adapter-subsystem provider config record for tests.
 * @param overrides - Field overrides
 * @returns Provider config record
 */
function makeProviderConfigRecord(overrides: Partial<ProviderConfigFileRecord> = {}): ProviderConfigFileRecord {
  return {
    id: 'config-1',
    definitionId: 'def-1',
    name: 'Anthropic Default',
    modelFilterMode: 'show-all',
    isDefault: true,
    enabled: true,
    auth: {
      mode: 'none',
      method: { owner: 'provider', providerDefinitionId: 'def-1', methodId: 'none' },
      hasCredentials: false,
    },
    ...overrides,
  };
}

/**
 * Build a minimal effective adapter record for tests.
 * @param overrides - Field overrides
 * @returns Effective adapter record
 */
function makeEffectiveAdapter(overrides: Partial<EffectiveAdapter> = {}): EffectiveAdapter {
  return {
    name: 'anthropic-sdk',
    displayName: 'Anthropic SDK',
    enabled: true,
    configCount: 1,
    readiness: 'ready',
    supportsLogImport: false,
    ...overrides,
  };
}
