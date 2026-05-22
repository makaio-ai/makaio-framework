import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChannelEndpoint, MakaioBus, type ChannelEndpoint } from '@makaio/bus-core';
import { CredentialSubjects } from '@makaio/contracts';
import { CredentialRefSchema } from '@makaio/contracts/config';
import { resolveSessionEnvironment } from '../resolve-session-environment.js';

vi.mock('@makaio/subsystem-client', () => ({
  resolveClientBinary: vi.fn().mockResolvedValue(undefined),
}));

describe('resolveSessionEnvironment', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    MakaioBus.__resetHandlers?.();
  });

  /**
   * Register a credential channel that resolves every ref to the supplied value.
   * @param value - Plaintext credential value returned by the channel
   */
  function setupCredentialBus(value: string): void {
    const token = 'resolve-session-environment-test-token';
    cleanups.push(
      MakaioBus.on(CredentialSubjects.getChannelToken, (ctx) => {
        ctx.setResult({ token });
      }),
    );
    const endpoint: ChannelEndpoint = createChannelEndpoint(
      MakaioBus.getContext(),
      'credentials',
      (channel) => {
        channel.on(CredentialSubjects.resolve, (ctx) => {
          ctx.setResult({ value });
        });
      },
      { token },
    );
    cleanups.push(() => endpoint.close());
  }

  it('strips ambient provider credentials before adding explicitly resolved credentials', async () => {
    setupCredentialBus('explicit-key');

    const result = await resolveSessionEnvironment({
      bus: MakaioBus,
      clientId: 'claude-code',
      baseEnv: {
        ANTHROPIC_API_KEY: 'ambient-key',
        OPENAI_API_KEY: 'ambient-openai-key',
        PATH: '/usr/bin',
      },
      providerContext: {
        providerConfigId: 'cfg-1',
        definitionId: 'anthropic',
        credentialRefs: {
          apiKey: CredentialRefSchema.parse('env:EXPLICIT_ANTHROPIC_API_KEY'),
        },
        credentialEnvVars: {
          apiKey: 'ANTHROPIC_API_KEY',
        },
        ambientCredentialEnvVars: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
      },
    });

    expect(result.spawnEnv).toMatchObject({
      ANTHROPIC_API_KEY: 'explicit-key',
      PATH: '/usr/bin',
    });
    expect(result.spawnEnv['OPENAI_API_KEY']).toBeUndefined();
  });

  it('does not forward ambient credentials when no credential refs are present', async () => {
    const result = await resolveSessionEnvironment({
      bus: MakaioBus,
      clientId: 'claude-code',
      baseEnv: {
        ANTHROPIC_API_KEY: 'ambient-key',
        PATH: '/usr/bin',
      },
      providerContext: {
        providerConfigId: 'cfg-1',
        definitionId: 'anthropic-oauth',
        credentialRefs: {},
        ambientCredentialEnvVars: ['ANTHROPIC_API_KEY'],
      },
    });

    expect(result.spawnEnv).toEqual({ PATH: '/usr/bin' });
  });
});
