import { describe, expect, it } from 'vitest';
import { providerAuthById } from '../provider.js';
import { adapterDefinition } from '../definition.js';

describe('Codex App Server normalized auth bindings', () => {
  it('declares OpenAI protocol on every provider ref', () => {
    expect(new Set(adapterDefinition.providers.map(({ protocol }) => protocol))).toEqual(new Set(['openai']));
  });

  it('declares native, access-token, and API-key RPC delivery without an API-key process sink', () => {
    const auth = providerAuthById['openai-codex'];
    expect(auth.bindings).toEqual([
      {
        method: { owner: 'client', clientId: 'codex', methodId: 'native' },
        deliveries: [{ kind: 'native-client', clientId: 'codex' }],
      },
      {
        method: { owner: 'client', clientId: 'codex', methodId: 'access-token' },
        deliveries: [{ kind: 'process-env', fields: { accessToken: 'CODEX_ACCESS_TOKEN' } }],
      },
      {
        method: { owner: 'provider', providerDefinitionId: 'openai-codex', methodId: 'api-key' },
        deliveries: [
          {
            kind: 'connector',
            target: 'codex.account-login.api-key',
            fields: { apiKey: 'apiKey' },
            constants: { type: 'apiKey' },
          },
        ],
      },
    ]);
    expect(auth.bindings.flatMap(({ deliveries }) => deliveries).filter(({ kind }) => kind === 'none')).toEqual([]);
  });

  it('scrubs selected sources, sinks, and the unsupported CODEX_API_KEY fallback exactly', () => {
    expect(providerAuthById['openai-codex'].scrubEnvVars).toEqual([
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'CODEX_ACCESS_TOKEN',
    ]);
  });
});
