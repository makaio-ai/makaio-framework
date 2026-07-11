import { describe, expect, it } from 'vitest';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import { CursorSdkAuthDeliveryError, resolveCursorAgentApiKey } from '../agent-auth.js';

function auth(target: string, values: Record<string, string>): ResolvedAdapterAuth {
  return { processEnv: {}, connectorDeliveries: [{ target, values }], configInheritance: 'empty' };
}

describe('Cursor SDK agent auth', () => {
  it('returns only the selected Agent.create API key', () => {
    expect(resolveCursorAgentApiKey(auth('cursor-sdk.agent-create', { apiKey: 'selected-key' }))).toBe('selected-key');
  });

  it('rejects missing, foreign, or malformed delivery without exposing values', () => {
    for (const snapshot of [
      undefined,
      auth('other.target', { apiKey: 'private-api-key' }),
      auth('cursor-sdk.agent-create', { apiKey: '' }),
      {
        ...auth('cursor-sdk.agent-create', { apiKey: 'private-api-key' }),
        processEnv: { CURSOR_API_KEY: 'private-api-key' },
      },
    ]) {
      let error: unknown;
      try {
        resolveCursorAgentApiKey(snapshot);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CursorSdkAuthDeliveryError);
      expect((error as Error).message).not.toContain('private-api-key');
    }
  });
});
