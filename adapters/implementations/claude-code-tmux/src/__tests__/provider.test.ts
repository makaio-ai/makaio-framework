import { describe, expect, it } from 'vitest';
import { providerAuthById, providerIds } from '../provider.js';
import { adapterDefinition } from '../definition.js';

describe('Claude Code tmux provider presets', () => {
  it('only declares Claude Code-authenticated Anthropic providers', () => {
    expect(providerIds).toEqual(['anthropic', 'anthropic-oauth']);
    expect(new Set(adapterDefinition.providers.map(({ protocol }) => protocol))).toEqual(new Set(['anthropic']));
  });

  it('declares exact API-key, native, and explicit OAuth deliveries', () => {
    expect(providerAuthById.anthropic.bindings).toEqual([
      {
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        deliveries: [{ kind: 'process-env', fields: { apiKey: 'ANTHROPIC_API_KEY' } }],
      },
    ]);
    expect(providerAuthById['anthropic-oauth'].bindings).toEqual([
      {
        method: { owner: 'client', clientId: 'claude-code', methodId: 'native' },
        deliveries: [{ kind: 'native-client', clientId: 'claude-code' }],
      },
      {
        method: { owner: 'client', clientId: 'claude-code', methodId: 'oauth-token' },
        deliveries: [{ kind: 'process-env', fields: { oauthToken: 'CLAUDE_CODE_OAUTH_TOKEN' } }],
      },
    ]);
    expect(providerAuthById.anthropic.scrubEnvVars).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_FOUNDRY_API_KEY',
      'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK',
      'ANTHROPIC_AWS_API_KEY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_MANTLE',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
      'CLAUDE_CODE_SKIP_MANTLE_AUTH',
      'CLAUDE_CODE_SKIP_VERTEX_AUTH',
    ]);
    expect(providerAuthById['anthropic-oauth'].scrubEnvVars).toEqual(providerAuthById.anthropic.scrubEnvVars);
  });
});
