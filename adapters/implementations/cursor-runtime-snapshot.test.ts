import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ExtensionSubjects } from '@makaio/kernel';
import type { ProviderRuntimeSnapshot } from '@makaio/services-core/adapter-subsystem';
import type { LoadedAdapter } from '@makaio/subsystem-adapter';
import { resolveAdapterRuntimeSnapshot } from '../../subsystems/adapter/src/adapter-runtime-snapshot.js';
import { providerDefinition } from '../../providers/cursor/src/definition.js';
import { adapterDefinition } from './cursor-sdk/src/definition.js';
import { AuthCredentialRefSchema } from '@makaio/contracts/auth';

const cursorProviderRef = adapterDefinition.providers[0];
const cursorAuthMethod = providerDefinition.authMethods?.[0];

/** Build the real Cursor provider selection without materializing plaintext. */
function cursorSnapshot(): ProviderRuntimeSnapshot {
  if (cursorAuthMethod?.mode !== 'explicit') throw new Error('Cursor provider must declare its API-key method.');
  const method = { owner: 'provider', providerDefinitionId: 'cursor', methodId: cursorAuthMethod.id } as const;

  return {
    config: {
      id: 'cursor-work',
      definitionId: 'cursor',
      name: 'Cursor Work',
      modelFilterMode: 'show-all',
      isDefault: true,
      enabled: true,
      auth: { mode: 'explicit', method, hasCredentials: true },
    },
    context: {
      state: 'resolved',
      providerConfigId: 'cursor-work',
      definitionId: 'cursor',
      auth: {
        mode: 'explicit',
        method,
        definition: cursorAuthMethod,
        credentialRefs: { apiKey: AuthCredentialRefSchema.parse('env:CURSOR_API_KEY') },
      },
    },
    definition: {
      ...providerDefinition,
      packageName: '@makaio/provider-cursor',
      availableModels: [],
      defaultModelFilterMode: 'show-all',
      authMethods: providerDefinition.authMethods ?? [],
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

/** Build loaded metadata from the real Cursor adapter/provider declarations. */
function loadedCursorAdapter(): LoadedAdapter {
  if (cursorProviderRef === undefined) throw new Error('Cursor adapter must declare its provider reference.');
  return {
    name: adapterDefinition.name,
    packageName: '@makaio/adapter-cursor-sdk',
    factory: async () => ({}),
    options: {},
    providerDefinitionIds: [cursorProviderRef.definitionId],
    providerRefs: [cursorProviderRef],
    providers: [
      {
        definition: providerDefinition,
        providerPackageName: '@makaio/provider-cursor',
        ...(cursorProviderRef.auth !== undefined && { auth: cursorProviderRef.auth }),
      },
    ],
  };
}

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

describe('Cursor SDK runtime snapshot', () => {
  it('resolves the exact Cursor provider ref without protocol or client inference', async () => {
    const cleanup = MakaioBus.on(ExtensionSubjects.contributions.catalog, ({ setResult }) => {
      setResult({ providers: [], clients: [] });
    });

    const result = await resolveAdapterRuntimeSnapshot({
      bus: MakaioBus,
      adapter: loadedCursorAdapter(),
      snapshot: cursorSnapshot(),
      isBound: true,
    });
    cleanup();

    expect(result).toMatchObject({
      status: 'resolved',
      runtime: {
        adapterName: 'cursor-sdk',
        adapterProviderAuth: cursorProviderRef?.auth,
        runtimePackages: {
          adapter: { packageName: '@makaio/adapter-cursor-sdk' },
          provider: { packageName: '@makaio/provider-cursor', definitionId: 'cursor' },
        },
      },
    });
    expect(result).not.toHaveProperty('runtime.adapterClientId');
    expect(result).not.toHaveProperty('runtime.runtimePackages.client');
  });
});
