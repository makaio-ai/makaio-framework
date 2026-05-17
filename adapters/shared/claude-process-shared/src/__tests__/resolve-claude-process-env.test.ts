import { describe, expect, it } from 'vitest';
import {
  CLAUDE_API_KEY_ENV,
  CLAUDE_BASE_URL_ENV,
  readClaudeProviderBaseUrl,
  resolveClaudeProcessEnv,
} from '../resolve-claude-process-env.js';

describe('resolveClaudeProcessEnv', () => {
  it('preserves OAuth fallback env when no explicit provider credential is resolved', () => {
    expect(
      resolveClaudeProcessEnv({
        spawnEnv: { PATH: '/usr/bin' },
        credentials: {},
        providerContext: { definitionId: 'anthropic-oauth' },
      }),
    ).toEqual({ PATH: '/usr/bin' });
  });

  it('maps provider-specific Anthropic-compatible API keys to Claude native env', () => {
    expect(
      resolveClaudeProcessEnv({
        spawnEnv: {
          PATH: '/usr/bin',
          OPENCODE_GO_API_KEY: 'opencode-secret',
        },
        credentials: { apiKey: 'opencode-secret' },
        providerContext: {
          definitionId: 'opencode-go-anthropic',
          credentialEnvVars: { apiKey: 'OPENCODE_GO_API_KEY' },
        },
      }),
    ).toEqual({
      PATH: '/usr/bin',
      [CLAUDE_API_KEY_ENV]: 'opencode-secret',
    });
  });

  it('keeps native Anthropic API key env names unchanged', () => {
    expect(
      resolveClaudeProcessEnv({
        spawnEnv: {
          PATH: '/usr/bin',
          [CLAUDE_API_KEY_ENV]: 'anthropic-secret',
        },
        credentials: { apiKey: 'anthropic-secret' },
        providerContext: {
          definitionId: 'anthropic',
          credentialEnvVars: { apiKey: CLAUDE_API_KEY_ENV },
        },
      }),
    ).toEqual({
      PATH: '/usr/bin',
      [CLAUDE_API_KEY_ENV]: 'anthropic-secret',
    });
  });

  it('sets the Claude native base URL env from the resolved provider baseUrl', () => {
    expect(
      resolveClaudeProcessEnv({
        spawnEnv: { PATH: '/usr/bin' },
        credentials: {},
        baseUrl: ' https://opencode.example.test/anthropic ',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      [CLAUDE_BASE_URL_ENV]: 'https://opencode.example.test/anthropic',
    });
  });

  it('falls back to the provider context endpoint when no providerConfig baseUrl is present', () => {
    expect(
      resolveClaudeProcessEnv({
        spawnEnv: { PATH: '/usr/bin' },
        credentials: {},
        providerContext: {
          definitionId: 'opencode-go-anthropic',
          endpointOverrides: { anthropic: 'https://opencode.example.test/from-context' },
        },
      }),
    ).toEqual({
      PATH: '/usr/bin',
      [CLAUDE_BASE_URL_ENV]: 'https://opencode.example.test/from-context',
    });
  });

  it('does not inherit ambient base URL when no Claude endpoint override is resolved', () => {
    expect(
      resolveClaudeProcessEnv({
        spawnEnv: { PATH: '/usr/bin', [CLAUDE_BASE_URL_ENV]: 'https://ambient.example.test' },
        credentials: {},
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
