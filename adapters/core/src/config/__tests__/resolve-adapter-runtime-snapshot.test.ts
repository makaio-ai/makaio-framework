import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { defineAdapterProviderAuth } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { AdapterRuntimeSnapshotError, resolveAdapterRuntimeSnapshot } from '../resolve-adapter-runtime-snapshot.js';

const METHOD = { owner: 'provider' as const, providerDefinitionId: 'public-provider', methodId: 'none' };
const METHOD_DEFINITION = { id: 'none', mode: 'none' as const, label: 'No authentication' };
const ADAPTER_AUTH = defineAdapterProviderAuth({
  bindings: [{ method: METHOD, deliveries: [{ kind: 'none' }] }],
  scrubEnvVars: [],
});

/**
 * Build a valid response whose selector can be varied independently of the request.
 * @param adapterName - Adapter selector returned by the runtime service
 * @param providerConfigId - Provider-config selector returned by the runtime service
 * @returns Resolved runtime snapshot response
 */
function runtimeResponse(adapterName: string, providerConfigId: string) {
  return {
    status: 'resolved' as const,
    runtime: {
      snapshot: {
        config: {
          id: providerConfigId,
          definitionId: 'public-provider',
          name: 'Public provider',
          modelFilterMode: 'show-all' as const,
          isDefault: true,
          enabled: true,
          auth: { mode: 'none' as const, method: METHOD, hasCredentials: false as const },
        },
        context: {
          state: 'resolved' as const,
          providerConfigId,
          definitionId: 'public-provider',
          auth: { mode: 'none' as const, method: METHOD, definition: METHOD_DEFINITION },
        },
        definition: {
          id: 'public-provider',
          packageName: '@makaio/provider-public',
          name: 'Public provider',
          availableModels: [],
          defaultModelFilterMode: 'show-all' as const,
          authMethods: [METHOD_DEFINITION],
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      adapterName,
      adapterProviderAuth: ADAPTER_AUTH,
      compatibleProviderAuths: [],
      runtimePackages: {
        adapter: { packageName: '@makaio/adapter-public' },
        provider: { packageName: '@makaio/provider-public', definitionId: 'public-provider' },
      },
    },
  };
}

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

describe('resolveAdapterRuntimeSnapshot selector correlation', () => {
  it('binds a response only when both selector coordinates match the request', async () => {
    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, ({ setResult }) => {
      setResult(runtimeResponse('public-adapter', 'public-config'));
    });

    await expect(
      resolveAdapterRuntimeSnapshot(MakaioBus, {
        adapterName: 'public-adapter',
        providerConfigId: 'public-config',
      }),
    ).resolves.toMatchObject({ boundProviderAuth: { auth: { mode: 'none' } } });
  });

  it.each([
    ['other-adapter', 'public-config'],
    ['public-adapter', 'other-config'],
  ])('rejects a response for selector %s/%s', async (adapterName, providerConfigId) => {
    MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, ({ setResult }) => {
      setResult(runtimeResponse(adapterName, providerConfigId));
    });

    const error = await resolveAdapterRuntimeSnapshot(MakaioBus, {
      adapterName: 'public-adapter',
      providerConfigId: 'public-config',
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AdapterRuntimeSnapshotError);
    expect((error as AdapterRuntimeSnapshotError).code).toBe('snapshot-identity-mismatch');
    expect(String(error)).not.toContain(adapterName);
    expect(String(error)).not.toContain(providerConfigId);
  });
});
