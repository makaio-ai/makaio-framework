import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import type { LoginAccountResponse } from '../protocol/generated/v2/index.js';
import type { JsonRpcClient } from '../utils/jsonRpcClient.js';

/** Connector operation selected by the normalized Codex API-key binding. */
export const CODEX_API_KEY_LOGIN_TARGET = 'codex.account-login.api-key';

/** Private API-key login material retained only for the connector lifetime. */
export interface CodexApiKeyAccountLogin {
  readonly type: 'apiKey';
  readonly apiKey: string;
}

/** Stable, credential-free Codex account-login failure categories. */
export type CodexAccountLoginErrorReason = 'invalid-delivery' | 'request-failed' | 'unexpected-response';

/** Typed login failure that never retains the credential or protocol payload. */
export class CodexAccountLoginError extends Error {
  /**
   * @param reason - Stable failure category safe for diagnostics
   */
  public constructor(public readonly reason: CodexAccountLoginErrorReason) {
    super(
      reason === 'invalid-delivery'
        ? 'Codex API-key authentication delivery is invalid.'
        : reason === 'request-failed'
          ? 'Codex API-key account login failed.'
          : 'Codex API-key account login returned an unexpected response.',
    );
    this.name = 'CodexAccountLoginError';
  }
}

/**
 * Consume the one connector delivery supported by Codex App Server.
 *
 * Native and access-token modes have no connector delivery. Any other shape
 * is rejected instead of being ignored, because ignoring it would silently
 * re-enable native or ambient client authentication.
 * @param auth - Final connector-local auth snapshot from AdapterAuthRuntime
 * @returns Private API-key login material, or `undefined` for non-RPC modes
 */
export function resolveCodexApiKeyAccountLogin(
  auth: ResolvedAdapterAuth | undefined,
): CodexApiKeyAccountLogin | undefined {
  const deliveries = auth?.connectorDeliveries ?? [];
  if (deliveries.length === 0) {
    return undefined;
  }
  if (deliveries.length !== 1 || deliveries[0]?.target !== CODEX_API_KEY_LOGIN_TARGET) {
    throw new CodexAccountLoginError('invalid-delivery');
  }

  const values = deliveries[0].values;
  const valueKeys = Object.keys(values).sort();
  if (
    valueKeys.length !== 2 ||
    valueKeys[0] !== 'apiKey' ||
    valueKeys[1] !== 'type' ||
    values['type'] !== 'apiKey' ||
    typeof values['apiKey'] !== 'string' ||
    values['apiKey'].trim() === ''
  ) {
    throw new CodexAccountLoginError('invalid-delivery');
  }

  return { type: 'apiKey', apiKey: values['apiKey'] };
}

/**
 * Authenticate one initialized Codex app-server process with its API key.
 * @param client - Initialized JSON-RPC client
 * @param login - Private normalized login material
 */
export async function loginCodexApiKeyAccount(client: JsonRpcClient, login: CodexApiKeyAccountLogin): Promise<void> {
  let response: LoginAccountResponse;
  try {
    response = await client.request<LoginAccountResponse>('account/login/start', login);
  } catch {
    throw new CodexAccountLoginError('request-failed');
  }

  if (response === null || typeof response !== 'object' || response.type !== 'apiKey') {
    throw new CodexAccountLoginError('unexpected-response');
  }
}
