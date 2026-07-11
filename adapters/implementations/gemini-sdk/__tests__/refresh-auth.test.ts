import { describe, expect, it } from 'vitest';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import { GeminiSdkAuthDeliveryError, resolveGeminiAuthOptions } from '../src/refresh-auth.js';

function auth(target: string, values: Record<string, string>): ResolvedAdapterAuth {
  return { processEnv: {}, connectorDeliveries: [{ target, values }], configInheritance: 'empty' };
}

describe('Gemini SDK refresh auth', () => {
  it('maps the selected API key only to refreshAuth', () => {
    expect(resolveGeminiAuthOptions(auth('gemini-sdk.refresh-auth', { apiKey: 'selected-key' }))).toEqual({
      apiKey: 'selected-key',
    });
  });

  it('rejects missing, empty-mode, or foreign delivery without exposing values', () => {
    const snapshots: Array<ResolvedAdapterAuth | undefined> = [
      undefined,
      { processEnv: {}, connectorDeliveries: [], configInheritance: 'empty' },
      { processEnv: {}, connectorDeliveries: [], configInheritance: 'auth-only' },
      auth('other.target', { apiKey: 'private-api-key' }),
      {
        ...auth('gemini-sdk.refresh-auth', { apiKey: 'private-api-key' }),
        processEnv: { GEMINI_API_KEY: 'private-api-key' },
      },
    ];
    for (const snapshot of snapshots) {
      let error: unknown;
      try {
        resolveGeminiAuthOptions(snapshot);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GeminiSdkAuthDeliveryError);
      expect((error as Error).message).not.toContain('private-api-key');
    }
  });
});
