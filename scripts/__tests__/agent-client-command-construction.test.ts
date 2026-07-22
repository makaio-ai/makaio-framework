import { describe, expect, it } from 'vitest';
import {
  buildChildEnvironment,
  buildClaudeCodeCommand,
  buildCodexCommand,
  buildSpawnCommand,
} from '../lib/agent-clients/command-construction.js';
import type { ProbeScenario } from '../lib/agent-clients/types.js';

const STUB_SCENARIO: ProbeScenario = {
  id: 'test-scenario',
  description: 'A test scenario',
  prompt: 'MAKAIO_PROBE_MARKER: test',
  allowedTools: ['Bash(cat MAKAIO_PROBE.md)'],
  expectedEvents: [],
  oracle: 'capture-only',
  candidateExpectedStatus: 'observer-only',
  sourceExpectedEffects: [],
  blockingCapable: false,
  expectedManagedCommand: 'hook received claude-code',
  timeoutSeconds: 30,
};

describe('buildChildEnvironment', () => {
  it('carries over only allowlisted system variables', () => {
    const parentEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      USER: 'probe-user',
      SECRET_KEY: 'should-be-stripped',
      RANDOM_VAR: 'should-be-stripped',
      ANTHROPIC_API_KEY: 'sk-test-key',
    };

    const env = buildChildEnvironment({
      provider: 'claude-code',
      credentialMode: 'api-key',
      configIsolationEnvVar: 'CLAUDE_CONFIG_DIR',
      tempConfigDir: '/tmp/probe-config',
      parentEnv,
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.USER).toBe('probe-user');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/probe-config');
    expect(env).not.toHaveProperty('SECRET_KEY');
    expect(env).not.toHaveProperty('RANDOM_VAR');
  });

  it('includes only the credential variable matching the active mode', () => {
    const parentEnv: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'sk-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok',
    };

    const env = buildChildEnvironment({
      provider: 'claude-code',
      credentialMode: 'oauth-token',
      configIsolationEnvVar: 'CLAUDE_CONFIG_DIR',
      tempConfigDir: '/tmp/config',
      parentEnv,
    });

    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
  });

  it('sets the config isolation env var to the temp directory', () => {
    const env = buildChildEnvironment({
      provider: 'codex',
      credentialMode: 'access-token',
      configIsolationEnvVar: 'CODEX_HOME',
      tempConfigDir: '/tmp/codex-config',
      parentEnv: { CODEX_ACCESS_TOKEN: 'tok' },
    });

    expect(env.CODEX_HOME).toBe('/tmp/codex-config');
    expect(env.CODEX_ACCESS_TOKEN).toBe('tok');
  });

  it('admits only provider-owned native authentication environment values', () => {
    const env = buildChildEnvironment({
      provider: 'claude-code',
      credentialMode: 'native-login',
      configIsolationEnvVar: 'CLAUDE_CONFIG_DIR',
      tempConfigDir: '/tmp/probe-config',
      nativeAuthEnv: {
        CLAUDE_CONFIG_DIR: '/wrong/config',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/probe-config',
        ANTHROPIC_API_KEY: 'must-not-pass',
        UNRELATED_SECRET: 'must-not-pass',
      },
    });

    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/probe-config');
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/tmp/probe-config');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('UNRELATED_SECRET');
  });
});

describe('buildClaudeCodeCommand', () => {
  it('constructs the expected CLI arguments for a Claude Code scenario', () => {
    const cmd = buildClaudeCodeCommand({
      executablePath: '/usr/local/bin/claude',
      scenario: STUB_SCENARIO,
      env: { PATH: '/usr/bin' },
      projectDir: '/tmp/project',
      settingsPath: '/tmp/settings.json',
    });

    expect(cmd.executable).toBe('/usr/local/bin/claude');
    expect(cmd.args).toContain('--print');
    expect(cmd.args).toContain('--output-format');
    expect(cmd.args).toContain('json');
    expect(cmd.args).toContain('--max-turns');
    expect(cmd.args[cmd.args.indexOf('--max-turns') + 1]).toBe('1');
    expect(cmd.args).toContain('--settings');
    expect(cmd.args).toContain('/tmp/settings.json');
    expect(cmd.args).toContain('--max-budget-usd');
    expect(cmd.args).toContain(STUB_SCENARIO.prompt);
    expect(cmd.args.indexOf(STUB_SCENARIO.prompt)).toBeLessThan(cmd.args.indexOf('--allowedTools'));
    expect(cmd.args.indexOf(STUB_SCENARIO.prompt)).toBeLessThan(cmd.args.indexOf('--add-dir'));
    expect(cmd.args[cmd.args.indexOf('--allowedTools') + 1]).toBe('Bash(cat MAKAIO_PROBE.md)');
    expect(cmd.timeoutMs).toBe(30_000);
  });

  it('does not add the marker-touch tool outside the scenario contract', () => {
    const cmd = buildClaudeCodeCommand({
      executablePath: '/usr/local/bin/claude',
      scenario: { ...STUB_SCENARIO, allowedTools: ['Bash(test -e MAKAIO_PROBE_TOOL_MARKER)'] },
      env: { PATH: '/usr/bin' },
      projectDir: '/tmp/project',
      settingsPath: '/tmp/settings.json',
    });

    expect(cmd.args[cmd.args.indexOf('--allowedTools') + 1]).toBe('Bash(test -e MAKAIO_PROBE_TOOL_MARKER)');
  });

  it('allows a second Claude turn only when the final response proves hook consumption', () => {
    const cmd = buildClaudeCodeCommand({
      executablePath: '/usr/local/bin/claude',
      scenario: { ...STUB_SCENARIO, oracle: 'final-response-must-contain-marker' },
      env: { PATH: '/usr/bin' },
      projectDir: '/tmp/project',
      settingsPath: '/tmp/settings.json',
    });

    expect(cmd.args[cmd.args.indexOf('--max-turns') + 1]).toBe('2');
  });
});

describe('buildCodexCommand', () => {
  it('constructs the expected CLI arguments for a Codex scenario', () => {
    const cmd = buildCodexCommand({
      executablePath: '/usr/local/bin/codex',
      scenario: STUB_SCENARIO,
      env: { PATH: '/usr/bin' },
      projectDir: '/tmp/project',
      settingsPath: '/tmp/hooks.json',
    });

    expect(cmd.executable).toBe('/usr/local/bin/codex');
    expect(cmd.args).toContain('exec');
    expect(cmd.args).toContain('--json');
    expect(cmd.args).toContain('--ephemeral');
    expect(cmd.args).toContain('approval_policy="never"');
    expect(cmd.args).not.toContain('--ask-for-approval');
    expect(cmd.args).toContain('workspace-write');
    expect(cmd.args).toContain(STUB_SCENARIO.prompt);
    expect(cmd.timeoutMs).toBe(30_000);
  });
});

describe('buildSpawnCommand', () => {
  it('dispatches to Claude Code builder for claude-code provider', () => {
    const cmd = buildSpawnCommand({
      provider: 'claude-code',
      executablePath: '/bin/claude',
      scenario: STUB_SCENARIO,
      env: {},
      projectDir: '/tmp/project',
      settingsPath: '/tmp/settings.json',
    });

    expect(cmd.args).toContain('--print');
    expect(cmd.args).toContain('--settings');
  });

  it('dispatches to Codex builder for codex provider', () => {
    const cmd = buildSpawnCommand({
      provider: 'codex',
      executablePath: '/bin/codex',
      scenario: STUB_SCENARIO,
      env: {},
      projectDir: '/tmp/project',
      settingsPath: '/tmp/hooks.json',
    });

    expect(cmd.args).toContain('exec');
  });

  it('computes timeout from scenario timeoutSeconds', () => {
    const scenario: ProbeScenario = { ...STUB_SCENARIO, timeoutSeconds: 120 };
    const cmd = buildSpawnCommand({
      provider: 'claude-code',
      executablePath: '/bin/claude',
      scenario,
      env: {},
      projectDir: '/tmp/project',
      settingsPath: '/tmp/settings.json',
    });

    expect(cmd.timeoutMs).toBe(120_000);
  });
});
