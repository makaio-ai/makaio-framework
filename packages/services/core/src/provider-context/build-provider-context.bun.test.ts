import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubsystemSubjects } from '../adapter-subsystem/namespace.js';
import { buildProviderContext } from './build-provider-context.js';

describe('buildProviderContext', () => {
  const cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(() => {
    cleanupFns.splice(0).forEach((cleanup) => cleanup());
  });

  it('forwards the adapter-subsystem provider context unchanged', async () => {
    cleanupFns.push(
      MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
        ctx.setResult({
          context: {
            providerConfigId: 'cfg-1',
            definitionId: 'provider-1',
            endpointOverrides: {
              anthropic: 'https://override.example.com',
            },
            credentialRefs: {},
            credentialEnvVars: { apiKey: 'API_KEY' },
          },
        });
      }),
    );

    await expect(buildProviderContext(MakaioBus, 'cfg-1')).resolves.toEqual({
      providerConfigId: 'cfg-1',
      definitionId: 'provider-1',
      endpointOverrides: {
        anthropic: 'https://override.example.com',
      },
      credentialRefs: {},
      credentialEnvVars: { apiKey: 'API_KEY' },
    });
  });

  it('throws when the provider config is missing', async () => {
    cleanupFns.push(
      MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, (ctx) => {
        ctx.setResult({ context: null });
      }),
    );

    await expect(buildProviderContext(MakaioBus, 'missing-config')).rejects.toThrow(
      "[buildProviderContext] ProviderConfig 'missing-config' not found",
    );
  });

  it('throws when the provider definition is missing', async () => {
    cleanupFns.push(
      MakaioBus.on(AdapterSubsystemSubjects.buildProviderContext, () => {
        throw new Error("[buildProviderContext] ProviderDefinition 'provider-missing' not found for config 'cfg-1'");
      }),
    );

    await expect(buildProviderContext(MakaioBus, 'cfg-1')).rejects.toThrow(
      "[buildProviderContext] ProviderDefinition 'provider-missing' not found for config 'cfg-1'",
    );
  });
});
