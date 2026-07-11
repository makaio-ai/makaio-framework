import { describe, expect, it } from 'vitest';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import { OpenAINodeAuthDeliveryError, resolveOpenAIConstructorAuth } from '../constructor-auth.js';

function auth(target: string, values: Record<string, string | null>): ResolvedAdapterAuth {
  return { processEnv: {}, connectorDeliveries: [{ target, values }], configInheritance: 'empty' };
}

describe('OpenAI Node constructor auth', () => {
  it('delivers the selected API key and explicitly suppresses admin-key fallback', () => {
    expect(
      resolveOpenAIConstructorAuth(auth('openai-node.constructor', { apiKey: 'selected-api-key', adminAPIKey: null })),
    ).toEqual({ apiKey: 'selected-api-key', adminAPIKey: null });
  });

  it('suppresses both ambient constructor credentials when auth is absent', () => {
    expect(resolveOpenAIConstructorAuth(undefined)).toEqual({ apiKey: null, adminAPIKey: null });
  });

  it('rejects foreign or malformed deliveries without exposing values', () => {
    for (const snapshot of [
      auth('other.target', { apiKey: 'private-api-key', adminAPIKey: null }),
      auth('openai-node.constructor', { apiKey: 'private-api-key', adminAPIKey: 'opposing-key' }),
      {
        ...auth('openai-node.constructor', { apiKey: 'private-api-key', adminAPIKey: null }),
        processEnv: { OPENAI_API_KEY: 'private-api-key' },
      },
    ]) {
      let error: unknown;
      try {
        resolveOpenAIConstructorAuth(snapshot);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(OpenAINodeAuthDeliveryError);
      expect((error as Error).message).not.toContain('private-api-key');
    }
  });
});
