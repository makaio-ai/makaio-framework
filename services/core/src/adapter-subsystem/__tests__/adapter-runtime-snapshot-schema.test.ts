import { describe, expect, it } from 'vitest';
import { AdapterRuntimeSnapshotSchema } from '../schemas.js';

/** Build one internally coherent client-owned runtime snapshot. */
function runtimeSnapshotFixture() {
  const method = { owner: 'client' as const, clientId: 'claude-code', methodId: 'native' };
  const definition = { id: 'native', mode: 'inferred' as const, label: 'Native sign-in' };
  return AdapterRuntimeSnapshotSchema.parse({
    snapshot: {
      config: {
        id: 'anthropic-native',
        definitionId: 'anthropic-oauth',
        name: 'Anthropic subscription',
        modelFilterMode: 'show-all' as const,
        isDefault: true,
        enabled: true,
        auth: { mode: 'inferred' as const, method, hasCredentials: false as const },
      },
      context: {
        state: 'resolved' as const,
        providerConfigId: 'anthropic-native',
        definitionId: 'anthropic-oauth',
        auth: { mode: 'inferred' as const, method, definition },
      },
      definition: {
        id: 'anthropic-oauth',
        packageName: '@makaio/provider-anthropic',
        name: 'Anthropic subscription',
        availableModels: [],
        defaultModelFilterMode: 'show-all' as const,
        authMethods: [],
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    },
    adapterName: 'claude-agent-sdk',
    adapterClientId: 'claude-code',
    providerProtocol: 'anthropic' as const,
    adapterProviderAuth: {
      bindings: [{ method, deliveries: [{ kind: 'native-client' as const, clientId: 'claude-code' }] }],
      scrubEnvVars: ['ANTHROPIC_API_KEY'],
    },
    compatibleProviderAuths: [],
    runtimePackages: {
      adapter: { packageName: '@makaio/adapter-claude-agent-sdk' },
      provider: { packageName: '@makaio/provider-anthropic', definitionId: 'anthropic-oauth' },
      client: { packageName: '@makaio/client-claude-code', clientId: 'claude-code' },
    },
  });
}

type RuntimeSnapshotFixture = ReturnType<typeof runtimeSnapshotFixture>;

describe('AdapterRuntimeSnapshotSchema identity coherence', () => {
  it('accepts one exact provider, client, package, and auth identity', () => {
    expect(AdapterRuntimeSnapshotSchema.safeParse(runtimeSnapshotFixture()).success).toBe(true);
  });

  it.each([
    [
      'provider definition package',
      (runtime: RuntimeSnapshotFixture) => {
        runtime.runtimePackages.provider.packageName = '@makaio/provider-other';
      },
    ],
    [
      'provider definition id',
      (runtime: RuntimeSnapshotFixture) => {
        runtime.runtimePackages.provider.definitionId = 'other-provider';
      },
    ],
    [
      'runtime client package id',
      (runtime: RuntimeSnapshotFixture) => {
        const clientPackage = runtime.runtimePackages.client;
        if (!clientPackage) {
          throw new Error('Expected the runtime snapshot fixture to include a client package.');
        }
        clientPackage.clientId = 'codex';
      },
    ],
    [
      'selected client id',
      (runtime: RuntimeSnapshotFixture) => {
        runtime.adapterClientId = 'codex';
      },
    ],
    [
      'selected auth binding',
      (runtime: RuntimeSnapshotFixture) => {
        runtime.adapterProviderAuth.bindings[0] = {
          method: { owner: 'client', clientId: 'codex', methodId: 'native' },
          deliveries: [{ kind: 'native-client', clientId: 'codex' }],
        };
      },
    ],
  ] as const)('rejects a mismatched %s', (_label, mutate) => {
    const runtime = structuredClone(runtimeSnapshotFixture());
    mutate(runtime);

    const result = AdapterRuntimeSnapshotSchema.safeParse(runtime);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: 'Adapter runtime snapshot identities must be internally coherent.' }),
        ]),
      );
    }
  });
});
