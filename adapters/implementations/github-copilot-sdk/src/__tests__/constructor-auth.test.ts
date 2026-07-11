import { describe, expect, it } from 'vitest';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import { CopilotSdkAuthDeliveryError, resolveCopilotGithubToken } from '../constructor-auth.js';

function auth(target: string, values: Record<string, string>): ResolvedAdapterAuth {
  return { processEnv: {}, connectorDeliveries: [{ target, values }], configInheritance: 'empty' };
}

describe('GitHub Copilot SDK constructor auth', () => {
  it('returns only the selected constructor token', () => {
    expect(
      resolveCopilotGithubToken(auth('github-copilot-sdk.constructor', { githubToken: 'selected-github-token' })),
    ).toBe('selected-github-token');
  });

  it('rejects missing, foreign, or malformed delivery without exposing values', () => {
    for (const snapshot of [
      undefined,
      auth('other.target', { githubToken: 'private-token' }),
      auth('github-copilot-sdk.constructor', { githubToken: '' }),
      {
        ...auth('github-copilot-sdk.constructor', { githubToken: 'private-token' }),
        processEnv: { COPILOT_TOKEN: 'private-token' },
      },
    ]) {
      let error: unknown;
      try {
        resolveCopilotGithubToken(snapshot);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CopilotSdkAuthDeliveryError);
      expect((error as Error).message).not.toContain('private-token');
    }
  });
});
