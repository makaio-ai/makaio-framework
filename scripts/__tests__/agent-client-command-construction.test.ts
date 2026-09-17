import { describe, expect, it } from 'vitest';
import {
  boundedByDeadline,
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

  it('refuses credential delivery through the native authentication environment', () => {
    const env = buildChildEnvironment({
      provider: 'claude-code',
      credentialMode: 'native-login',
      configIsolationEnvVar: 'CLAUDE_CONFIG_DIR',
      tempConfigDir: '/tmp/probe-config',
      nativeAuthEnv: {
        CLAUDE_CONFIG_DIR: '/wrong/config',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/probe-config',
        ANTHROPIC_API_KEY: 'must-not-pass',
        CLAUDE_CODE_OAUTH_TOKEN: 'must-not-pass',
      },
      parentEnv: {},
    });

    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/probe-config');
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/tmp/probe-config');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('delivers the lease-published keychain account when the parent environment has no USER', () => {
    const env = buildChildEnvironment({
      provider: 'claude-code',
      credentialMode: 'native-login',
      configIsolationEnvVar: 'CLAUDE_CONFIG_DIR',
      tempConfigDir: '/tmp/probe-config',
      nativeAuthEnv: {
        CLAUDE_CONFIG_DIR: '/tmp/probe-config',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/probe-config',
        USER: 'lease-account',
      },
      parentEnv: { PATH: '/usr/bin' },
    });

    expect(env.USER).toBe('lease-account');
  });

  it('prefers the lease-published keychain account over a sanitized parent USER', () => {
    const env = buildChildEnvironment({
      provider: 'claude-code',
      credentialMode: 'native-login',
      configIsolationEnvVar: 'CLAUDE_CONFIG_DIR',
      tempConfigDir: '/tmp/probe-config',
      nativeAuthEnv: {
        CLAUDE_CONFIG_DIR: '/tmp/probe-config',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/probe-config',
        USER: 'lease-account',
      },
      parentEnv: { PATH: '/usr/bin', USER: 'sanitized-runner' },
    });

    expect(env.USER).toBe('lease-account');
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
    expect(cmd.args[cmd.args.indexOf('--max-turns') + 1]).toBe('2');
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

  it('refuses a scenario that restates a harness-owned flag', () => {
    for (const cliArgs of [
      ['--max-turns', '1'],
      ['--max-turns=1'],
      ['--output-format', 'text'],
      ['--add-dir', '/tmp'],
    ]) {
      expect(() =>
        buildClaudeCodeCommand({
          executablePath: '/usr/local/bin/claude',
          scenario: { ...STUB_SCENARIO, cliArgs },
          env: { PATH: '/usr/bin' },
          projectDir: '/tmp/project',
          settingsPath: '/tmp/settings.json',
        }),
      ).toThrow(/harness-owned argument/);
    }
  });

  it('bounds every oracle at the same two turns so no run ends mid-turn', () => {
    for (const oracle of ['unobserved', 'sentinel-must-allow-tool', 'final-response-must-contain-marker'] as const) {
      const cmd = buildClaudeCodeCommand({
        executablePath: '/usr/local/bin/claude',
        scenario: { ...STUB_SCENARIO, oracle },
        env: { PATH: '/usr/bin' },
        projectDir: '/tmp/project',
        settingsPath: '/tmp/settings.json',
      });

      expect(cmd.args[cmd.args.indexOf('--max-turns') + 1]).toBe('2');
    }
  });
});

describe('boundedByDeadline', () => {
  const SEEDED_SCENARIO: ProbeScenario = { ...STUB_SCENARIO, seedPrompt: 'MAKAIO_PROBE_MARKER: seed' };

  /**
   * Builds the command for one run of the seeded scenario.
   * @param invocation - Which run of the seeded scenario to construct.
   * @returns The provider command for that run.
   */
  function seededCommand(invocation: {
    seed?: boolean;
    resumeSessionId?: string;
  }): ReturnType<typeof buildSpawnCommand> {
    return buildSpawnCommand({
      provider: 'claude-code',
      executablePath: '/usr/local/bin/claude',
      scenario: SEEDED_SCENARIO,
      env: { PATH: '/usr/bin' },
      projectDir: '/tmp/project',
      settingsPath: '/tmp/settings.json',
      invocation,
    });
  }

  it('spends one scenario budget across a seeded scenario instead of one per run', () => {
    // The scenario budget is what the probe's remaining wall clock allowed, so
    // both runs of a seeded scenario have to fit inside it together.
    const startedAt = 1_000_000;
    const deadlineMs = startedAt + SEEDED_SCENARIO.timeoutSeconds * 1000;
    const resumedStartedAt = startedAt + 22_000;
    const seed = boundedByDeadline(seededCommand({ seed: true }), deadlineMs, startedAt);
    const resumed = boundedByDeadline(seededCommand({ resumeSessionId: 'session-1' }), deadlineMs, resumedStartedAt);

    // Unbounded, the resumed run claims the whole scenario budget a second
    // time and can outlive the deadline by a full scenario timeout.
    expect(seededCommand({ resumeSessionId: 'session-1' }).timeoutMs).toBe(30_000);
    expect(seed.timeoutMs).toBe(30_000);
    expect(resumed.timeoutMs).toBe(8_000);
    expect(resumedStartedAt + resumed.timeoutMs).toBe(deadlineMs);
  });

  it('leaves no deadline for a run that starts after the scenario budget is gone', () => {
    const startedAt = 1_000_000;
    const deadlineMs = startedAt + SEEDED_SCENARIO.timeoutSeconds * 1000;

    expect(
      boundedByDeadline(seededCommand({ resumeSessionId: 'session-1' }), deadlineMs, deadlineMs + 5_000).timeoutMs,
    ).toBe(0);
  });

  it('keeps an unseeded scenario at its own bound and changes nothing else', () => {
    const command = buildSpawnCommand({
      provider: 'claude-code',
      executablePath: '/usr/local/bin/claude',
      scenario: STUB_SCENARIO,
      env: { PATH: '/usr/bin' },
      projectDir: '/tmp/project',
      settingsPath: '/tmp/settings.json',
    });
    const bounded = boundedByDeadline(command, 1_000_000 + STUB_SCENARIO.timeoutSeconds * 1000, 1_000_000);

    expect(bounded).toEqual(command);
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

describe('buildCodexCommand cliArgs', () => {
  /**
   * Builds a Codex command for a scenario carrying extra CLI arguments.
   * @param cliArgs - Scenario-owned provider-native arguments.
   * @returns The constructed Codex command.
   */
  function build(cliArgs: readonly string[]): ReturnType<typeof buildCodexCommand> {
    return buildCodexCommand({
      executablePath: '/usr/local/bin/codex',
      scenario: { ...STUB_SCENARIO, cliArgs },
      env: { PATH: '/usr/bin' },
      projectDir: '/tmp/project',
      settingsPath: '/tmp/hooks.json',
    });
  }

  it('refuses a scenario that restates a harness-owned argument', () => {
    for (const cliArgs of [['--json'], ['--sandbox', 'danger-full-access'], ['--cd=/elsewhere'], ['exec']]) {
      expect(() => build(cliArgs)).toThrow(/harness-owned argument/);
    }
  });

  it('keeps repeatable scenario-owned configuration', () => {
    const cmd = build(['--config', 'model_auto_compact_token_limit=10000']);

    expect(cmd.args).toContain('model_auto_compact_token_limit=10000');
    expect(cmd.args.indexOf('model_auto_compact_token_limit=10000')).toBeLessThan(
      cmd.args.indexOf(STUB_SCENARIO.prompt),
    );
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
