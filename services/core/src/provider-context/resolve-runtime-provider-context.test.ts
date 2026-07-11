import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { defineAdapterProviderAuth } from '@makaio/contracts';
import { AdapterSubsystemSubjects } from '../adapter-subsystem/namespace.js';
import type { AdapterRuntimeSnapshotResolution } from '../adapter-subsystem/schemas.js';
import {
  resolveRuntimeProviderContext,
  RuntimeProviderContextResolutionError,
} from './resolve-runtime-provider-context.js';

const METHOD = {
  owner: 'provider' as const,
  providerDefinitionId: 'provider-1',
  methodId: 'none',
};
const METHOD_DEFINITION = { id: 'none', mode: 'none' as const, label: 'No authentication' };
const RESOLVED_CONTEXT = {
  state: 'resolved' as const,
  providerConfigId: 'cfg-1',
  definitionId: 'provider-1',
  auth: {
    mode: 'none' as const,
    method: METHOD,
    definition: METHOD_DEFINITION,
  },
};

/**
 * Build a complete adapter-qualified runtime response.
 * @returns Resolved runtime fixture accepted by the adapter snapshot contract.
 */
function resolvedRuntimeResponse(): AdapterRuntimeSnapshotResolution {
  return {
    status: 'resolved' as const,
    runtime: {
      snapshot: {
        config: {
          id: 'cfg-1',
          definitionId: 'provider-1',
          name: 'Provider 1',
          modelFilterMode: 'show-all' as const,
          isDefault: true,
          enabled: true,
          auth: { mode: 'none' as const, method: METHOD, hasCredentials: false as const },
        },
        context: RESOLVED_CONTEXT,
        definition: {
          id: 'provider-1',
          packageName: '@makaio/provider-test',
          name: 'Provider 1',
          availableModels: [],
          defaultModelFilterMode: 'show-all' as const,
          authMethods: [METHOD_DEFINITION],
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      adapterName: 'adapter-1',
      adapterProviderAuth: defineAdapterProviderAuth({
        bindings: [{ method: METHOD, deliveries: [{ kind: 'none' as const }] }],
        scrubEnvVars: [],
      }),
      compatibleProviderAuths: [],
      runtimePackages: {
        adapter: { packageName: '@makaio/adapter-test' },
        provider: { packageName: '@makaio/provider-test', definitionId: 'provider-1' },
      },
    },
  };
}

describe('resolveRuntimeProviderContext', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    MakaioBus.__resetHandlers?.();
  });

  it('returns only the resolved context from the adapter-qualified atomic snapshot', async () => {
    cleanups.push(
      MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
        expect(ctx.payload).toEqual({ adapterName: 'adapter-1', providerConfigId: 'cfg-1' });
        ctx.setResult(resolvedRuntimeResponse());
      }),
    );

    await expect(
      resolveRuntimeProviderContext(MakaioBus, { adapterName: 'adapter-1', providerConfigId: 'cfg-1' }),
    ).resolves.toEqual(RESOLVED_CONTEXT);
  });

  it.each([
    'provider-config-not-found',
    'provider-config-disabled',
  ] as const)('raises a typed credential-free error for %s', async (code) => {
    cleanups.push(
      MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
        ctx.setResult({ status: 'error', code });
      }),
    );

    const error = await resolveRuntimeProviderContext(MakaioBus, {
      adapterName: 'adapter-1',
      providerConfigId: 'cfg-1',
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RuntimeProviderContextResolutionError);
    expect((error as RuntimeProviderContextResolutionError).code).toBe(code);
    expect((error as Error).message).not.toContain('cfg-1');
  });

  it('rejects a valid snapshot returned for a different request selector', async () => {
    cleanups.push(
      MakaioBus.on(AdapterSubsystemSubjects.resolveAdapterRuntimeSnapshot, (ctx) => {
        ctx.setResult(resolvedRuntimeResponse());
      }),
    );

    const error = await resolveRuntimeProviderContext(MakaioBus, {
      adapterName: 'requested-adapter',
      providerConfigId: 'requested-config',
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(RuntimeProviderContextResolutionError);
    expect((error as RuntimeProviderContextResolutionError).code).toBe('snapshot-identity-mismatch');
    expect(String(error)).not.toContain('cfg-1');
    expect(String(error)).not.toContain('adapter-1');
  });
});
