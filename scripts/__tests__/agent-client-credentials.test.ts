import * as fs from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { prepareNativeLoginLease, resolveCredentialMode } from '../lib/agent-clients/credentials.js';
import { parseProbeArgs, runProbe } from '../test-agent-clients.js';

describe('resolveCredentialMode', () => {
  it('resolves api-key mode when only ANTHROPIC_API_KEY is set', () => {
    const result = resolveCredentialMode({
      provider: 'claude-code',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
    });
    expect(result.mode).toBe('api-key');
    expect(result.error).toBeUndefined();
  });

  it('resolves oauth-token mode when only CLAUDE_CODE_OAUTH_TOKEN is set', () => {
    const result = resolveCredentialMode({
      provider: 'claude-code',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' },
    });
    expect(result.mode).toBe('oauth-token');
    expect(result.error).toBeUndefined();
  });

  it('resolves access-token mode for Codex', () => {
    const result = resolveCredentialMode({
      provider: 'codex',
      env: { CODEX_ACCESS_TOKEN: 'tok-test' },
    });
    expect(result.mode).toBe('access-token');
    expect(result.error).toBeUndefined();
  });

  it('selects native-login when no explicit credential variable is set', () => {
    const result = resolveCredentialMode({
      provider: 'claude-code',
      env: {},
    });
    expect(result.mode).toBe('native-login');
    expect(result.error).toBeUndefined();
  });

  it('parses an empty explicit environment as a native-login probe', () => {
    expect(parseProbeArgs(['--provider', 'codex'], {}).credentialMode).toBe('native-login');
  });

  it('selects native-login when credential variables are empty', () => {
    const result = resolveCredentialMode({
      provider: 'codex',
      env: { CODEX_ACCESS_TOKEN: '' },
    });
    expect(result.mode).toBe('native-login');
  });

  it('fails when multiple credential variables are set for Claude Code', () => {
    const result = resolveCredentialMode({
      provider: 'claude-code',
      env: {
        ANTHROPIC_API_KEY: 'sk-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok',
      },
    });
    expect(result.mode).toBeUndefined();
    expect(result.error).toContain('Ambiguous credentials');
    expect(result.error).toContain('ANTHROPIC_API_KEY');
    expect(result.error).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('ignores unrelated environment variables', () => {
    const result = resolveCredentialMode({
      provider: 'codex',
      env: {
        ANTHROPIC_API_KEY: 'sk-key',
        CODEX_ACCESS_TOKEN: 'tok-test',
      },
    });
    expect(result.mode).toBe('access-token');
    expect(result.error).toBeUndefined();
  });

  it('requires fake client-owned setup to materialize native authentication before returning a lease', async () => {
    const teardown = vi.fn(async () => undefined);
    const lease = await prepareNativeLoginLease({
      provider: 'claude-code',
      configDir: '/tmp/probe-config',
      projectDir: '/tmp/probe-project',
      factory: {
        prepare: async () => ({
          env: {
            CLAUDE_CONFIG_DIR: '/tmp/probe-config',
            CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/probe-config',
          },
          authMaterialized: true,
          teardown,
        }),
      },
    });

    expect(lease.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/tmp/probe-config');
    expect(teardown).not.toHaveBeenCalled();
    await lease.teardown();
    expect(teardown).toHaveBeenCalledOnce();
  });

  it('tears down an unmaterialized native login before rejecting it', async () => {
    const teardown = vi.fn(async () => undefined);

    await expect(
      prepareNativeLoginLease({
        provider: 'codex',
        configDir: '/tmp/probe-config',
        projectDir: '/tmp/probe-project',
        factory: {
          prepare: async () => ({ env: { CODEX_HOME: '/tmp/probe-config' }, authMaterialized: false, teardown }),
        },
      }),
    ).rejects.toThrow('Native login was not materialized');

    expect(teardown).toHaveBeenCalledOnce();
  });

  it('does not start a scenario when client-owned native auth is absent', async () => {
    const runScenario = vi.fn();
    const teardown = vi.fn(async () => undefined);

    await expect(
      runProbe(
        {
          provider: 'codex',
          credentialMode: 'native-login',
          updateFixtures: false,
          maxScenarios: 1,
          maxWallClockSeconds: 1,
        },
        {
          executablePath: '/fake/codex',
          nativeLoginLeaseFactory: {
            prepare: async () => ({ env: { CODEX_HOME: '/tmp/probe-config' }, authMaterialized: false, teardown }),
          },
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario,
        },
      ),
    ).rejects.toThrow('Native login was not materialized');

    expect(runScenario).not.toHaveBeenCalled();
    expect(teardown).toHaveBeenCalledOnce();
  });

  it('tears down a native lease when a scenario fails before workspace cleanup', async () => {
    const observed: string[] = [];
    let configDir: string | undefined;
    const teardown = vi.fn(async () => {
      if (!configDir) throw new Error('Missing fake native config directory');
      await fs.access(configDir);
      observed.push('teardown');
    });
    const runScenario = vi.fn(async () => {
      observed.push('scenario');
      throw new Error('fake scenario failure');
    });

    await expect(
      runProbe(
        {
          provider: 'claude-code',
          credentialMode: 'native-login',
          updateFixtures: false,
          maxScenarios: 1,
          maxWallClockSeconds: 1,
        },
        {
          executablePath: '/fake/claude',
          nativeLoginLeaseFactory: {
            prepare: async (params) => {
              configDir = params.configDir;
              return {
                env: {
                  CLAUDE_CONFIG_DIR: params.configDir,
                  CLAUDE_SECURESTORAGE_CONFIG_DIR: params.configDir,
                },
                authMaterialized: true,
                teardown,
              };
            },
          },
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario,
        },
      ),
    ).rejects.toThrow('fake scenario failure');

    expect(observed).toEqual(['scenario', 'teardown']);
    if (!configDir) throw new Error('Missing fake native config directory');
    await expect(fs.access(configDir)).rejects.toThrow();
  });
});
