import { describe, expect, it } from 'vitest';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import {
  PiSdkAuthDeliveryError,
  PiSdkProviderContextError,
  PiSdkProviderProtocolError,
  requirePiProviderContext,
  requirePiProviderProtocol,
  resolvePiProviderApiKey,
} from '../provider-auth.js';

function auth(target: string, values: Record<string, string>): ResolvedAdapterAuth {
  return { processEnv: {}, connectorDeliveries: [{ target, values }], configInheritance: 'empty' };
}

describe('Pi SDK provider auth', () => {
  it('returns only the selected provider API key', () => {
    expect(resolvePiProviderApiKey(auth('pi-sdk.provider-auth', { apiKey: 'selected-key' }))).toBe('selected-key');
  });

  it('rejects missing, foreign, or malformed delivery without exposing values', () => {
    for (const snapshot of [
      undefined,
      auth('other.target', { apiKey: 'private-api-key' }),
      auth('pi-sdk.provider-auth', { apiKey: '' }),
      {
        ...auth('pi-sdk.provider-auth', { apiKey: 'private-api-key' }),
        processEnv: { PI_API_KEY: 'private-api-key' },
      },
    ]) {
      let error: unknown;
      try {
        resolvePiProviderApiKey(snapshot);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PiSdkAuthDeliveryError);
      expect((error as Error).message).not.toContain('private-api-key');
    }
  });

  it('requires a resolved provider context instead of defaulting provider identity', () => {
    for (const context of [undefined, { state: 'unresolved' as const }]) {
      expect(() => requirePiProviderContext(context)).toThrow(PiSdkProviderContextError);
    }

    const resolved = {
      state: 'resolved' as const,
      providerConfigId: 'provider-config',
      definitionId: 'openai',
      auth: {
        mode: 'none' as const,
        method: { owner: 'provider' as const, providerDefinitionId: 'openai', methodId: 'none' },
        definition: { id: 'none', mode: 'none' as const, label: 'None' },
      },
    };
    expect(requirePiProviderContext(resolved)).toBe(resolved);
  });

  it('requires a selected adapter/provider protocol instead of guessing from provider identity', () => {
    expect(() => requirePiProviderProtocol(undefined)).toThrow(PiSdkProviderProtocolError);
    expect(requirePiProviderProtocol('openai')).toBe('openai');
  });
});
