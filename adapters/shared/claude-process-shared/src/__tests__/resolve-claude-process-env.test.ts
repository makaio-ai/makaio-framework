import { describe, expect, it } from 'vitest';
import {
  CLAUDE_BASE_URL_ENV,
  readClaudeProviderBaseUrl,
  resolveClaudeProcessEnv,
} from '../resolve-claude-process-env.js';

describe('resolveClaudeProcessEnv', () => {
  it('preserves the central auth selection without remapping or fallback', () => {
    expect(
      resolveClaudeProcessEnv({
        spawnEnv: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' },
      }),
    ).toEqual({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret' });
  });

  it('preserves a centrally delivered API key', () => {
    expect(
      resolveClaudeProcessEnv({
        spawnEnv: {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'api-secret',
        },
      }),
    ).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'api-secret',
    });
  });

  it('sets the Claude native base URL env from the resolved provider baseUrl', () => {
    expect(
      resolveClaudeProcessEnv({
        spawnEnv: { PATH: '/usr/bin' },
        baseUrl: ' https://opencode.example.test/anthropic ',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      [CLAUDE_BASE_URL_ENV]: 'https://opencode.example.test/anthropic',
    });
  });

  it('does not inherit ambient base URL when no Claude endpoint override is resolved', () => {
    expect(
      resolveClaudeProcessEnv({
        spawnEnv: { PATH: '/usr/bin', [CLAUDE_BASE_URL_ENV]: 'https://ambient.example.test' },
      }),
    ).toEqual({ PATH: '/usr/bin' });
  });
});

describe('readClaudeProviderBaseUrl', () => {
  it('reads the generic providerConfig baseUrl without widening adapter-specific types', () => {
    expect(readClaudeProviderBaseUrl({ baseUrl: ' https://example.test ' })).toBe('https://example.test');
    expect(readClaudeProviderBaseUrl({ baseUrl: '' })).toBeUndefined();
    expect(readClaudeProviderBaseUrl(undefined)).toBeUndefined();
  });
});
