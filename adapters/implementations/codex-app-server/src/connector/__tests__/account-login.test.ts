import { describe, expect, it } from 'vitest';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import { CodexAccountLoginError, loginCodexApiKeyAccount, resolveCodexApiKeyAccountLogin } from '../account-login.js';
import { MockJsonRpcClient } from '../../__tests__/shared.js';

/**
 * Build a connector snapshot around one test delivery.
 * @param target - Adapter-owned connector operation identifier
 * @param values - Delivery fields supplied to the operation
 * @returns Connector-local resolved auth snapshot
 */
function authWithDelivery(target: string, values: Record<string, string>): ResolvedAdapterAuth {
  return {
    processEnv: {},
    connectorDeliveries: [{ target, values }],
    configInheritance: 'empty',
  };
}

describe('Codex API-key account login', () => {
  it('rejects unknown or malformed connector deliveries without retaining their values', () => {
    const snapshots = [
      authWithDelivery('other.operation', { type: 'apiKey', apiKey: 'private-api-key' }),
      authWithDelivery('codex.account-login.api-key', { type: 'apiKey', apiKey: 'private-api-key', extra: 'value' }),
      authWithDelivery('codex.account-login.api-key', { type: 'chatgpt', apiKey: 'private-api-key' }),
    ];

    for (const snapshot of snapshots) {
      let captured: unknown;
      try {
        resolveCodexApiKeyAccountLogin(snapshot);
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(CodexAccountLoginError);
      expect((captured as Error).message).not.toContain('private-api-key');
    }
  });

  it('rejects a non-api-key response with a typed credential-free error', async () => {
    class ChatGptResponseClient extends MockJsonRpcClient {
      public override async request<T>(): Promise<T> {
        return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://example.test' } as T;
      }
    }
    const client = new ChatGptResponseClient();

    await expect(loginCodexApiKeyAccount(client, { type: 'apiKey', apiKey: 'private-api-key' })).rejects.toMatchObject({
      reason: 'unexpected-response',
    } satisfies Partial<CodexAccountLoginError>);
  });
});
