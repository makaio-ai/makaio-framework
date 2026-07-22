/** @packageDocumentation */
import type { CredentialMode, ProbeScenario, ProviderId } from './types.js';
import { CHILD_ENV_ALLOWLIST, PROVIDER_CREDENTIAL_VARS, PROVIDER_NATIVE_AUTH_ENV_VARS } from './types.js';

/** A CLI command with a hard per-scenario deadline. */
export interface SpawnCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  /** Working directory for the isolated synthetic project. */
  readonly cwd: string;
  readonly timeoutMs: number;
}

/**
 * Builds the intentionally small child environment.
 * @param params - Provider credential selection, isolation variable, and parent environment.
 * @returns Environment containing only process requirements and one credential.
 */
export function buildChildEnvironment(params: {
  provider: ProviderId;
  credentialMode: CredentialMode;
  configIsolationEnvVar: string;
  tempConfigDir: string;
  /** Client-owned isolated authentication environment for native-login mode. */
  nativeAuthEnv?: Readonly<Record<string, string>>;
  parentEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const {
    provider,
    credentialMode,
    configIsolationEnvVar,
    tempConfigDir,
    nativeAuthEnv,
    parentEnv = process.env,
  } = params;
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value) env[key] = value;
  }
  for (const [name, mode] of Object.entries(PROVIDER_CREDENTIAL_VARS[provider])) {
    if (mode === credentialMode && parentEnv[name]) env[name] = parentEnv[name]!;
  }
  if (credentialMode === 'native-login' && nativeAuthEnv) {
    for (const name of PROVIDER_NATIVE_AUTH_ENV_VARS[provider]) {
      const value = nativeAuthEnv[name];
      if (value) env[name] = value;
    }
  }
  env[configIsolationEnvVar] = tempConfigDir;
  return env;
}

/**
 * Constructs documented Claude Code print-mode invocation arguments.
 * @param params - Isolated executable, project, settings file, scenario, and child environment.
 * @returns Claude Code print-mode command.
 */
export function buildClaudeCodeCommand(params: {
  executablePath: string;
  scenario: ProbeScenario;
  env: Record<string, string>;
  projectDir: string;
  settingsPath: string;
}): SpawnCommand {
  const { executablePath, scenario, env, projectDir, settingsPath } = params;
  return {
    executable: executablePath,
    args: [
      '--print',
      scenario.prompt,
      '--output-format',
      'json',
      '--max-turns',
      scenario.oracle === 'final-response-must-contain-marker' ? '2' : '1',
      '--max-budget-usd',
      '0.25',
      '--no-session-persistence',
      '--settings',
      settingsPath,
      '--setting-sources',
      'user,project,local',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      scenario.allowedTools.join(','),
      '--add-dir',
      projectDir,
    ],
    env,
    cwd: projectDir,
    timeoutMs: scenario.timeoutSeconds * 1000,
  };
}

/**
 * Constructs documented Codex non-interactive invocation arguments.
 * @param params - Isolated executable, project, scenario, and child environment.
 * @returns Codex non-interactive command.
 */
export function buildCodexCommand(params: {
  executablePath: string;
  scenario: ProbeScenario;
  env: Record<string, string>;
  projectDir: string;
  settingsPath: string;
}): SpawnCommand {
  const { executablePath, scenario, env, projectDir } = params;
  return {
    executable: executablePath,
    args: [
      'exec',
      '--json',
      '--ephemeral',
      '--config',
      'approval_policy="never"',
      '--sandbox',
      'workspace-write',
      '--dangerously-bypass-hook-trust',
      '--cd',
      projectDir,
      '--skip-git-repo-check',
      scenario.prompt,
    ],
    env,
    cwd: projectDir,
    timeoutMs: scenario.timeoutSeconds * 1000,
  };
}

/**
 * Dispatches to the provider-specific, documented command shape.
 * @param params - Provider and common command-construction inputs.
 * @returns Provider-specific CLI command.
 */
export function buildSpawnCommand(params: {
  provider: ProviderId;
  executablePath: string;
  scenario: ProbeScenario;
  env: Record<string, string>;
  projectDir: string;
  settingsPath: string;
}): SpawnCommand {
  return params.provider === 'claude-code' ? buildClaudeCodeCommand(params) : buildCodexCommand(params);
}
