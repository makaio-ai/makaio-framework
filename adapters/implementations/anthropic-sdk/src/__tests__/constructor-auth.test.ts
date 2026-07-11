import { describe, expect, it } from 'vitest';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import { AnthropicSdkAuthDeliveryError, resolveAnthropicConstructorAuth } from '../constructor-auth.js';

function auth(target: string, values: Record<string, string | null>): ResolvedAdapterAuth {
  return { processEnv: {}, connectorDeliveries: [{ target, values }], configInheritance: 'empty' };
}

describe('Anthropic SDK constructor auth', () => {
  it('delivers the selected API key and explicitly suppresses bearer-token fallback', () => {
    expect(
      resolveAnthropicConstructorAuth(
        auth('anthropic-sdk.constructor', { apiKey: 'selected-api-key', authToken: null }),
      ),
    ).toEqual({ apiKey: 'selected-api-key', authToken: null });
  });

  it('suppresses both ambient constructor credentials when auth is absent', () => {
    expect(resolveAnthropicConstructorAuth(undefined)).toEqual({ apiKey: null, authToken: null });
  });

  it('rejects foreign or malformed deliveries without exposing values', () => {
    for (const snapshot of [
      auth('other.target', { apiKey: 'private-api-key', authToken: null }),
      auth('anthropic-sdk.constructor', { apiKey: 'private-api-key', authToken: 'opposing-token' }),
      {
        ...auth('anthropic-sdk.constructor', { apiKey: 'private-api-key', authToken: null }),
        processEnv: { ANTHROPIC_API_KEY: 'private-api-key' },
      },
    ]) {
      let error: unknown;
      try {
        resolveAnthropicConstructorAuth(snapshot);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AnthropicSdkAuthDeliveryError);
      expect((error as Error).message).not.toContain('private-api-key');
    }
  });
});
