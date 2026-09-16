/** @packageDocumentation */
import type { CredentialMode, ProbeScenario, ProviderId } from './types.js';
import { CHILD_ENV_ALLOWLIST, PROVIDER_CREDENTIAL_VARS } from './types.js';

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
 *
 * Ambient state is admitted only through {@link CHILD_ENV_ALLOWLIST} and the
 * single credential variable selected by the active mode. A native-login lease
 * is a different kind of source: it is client-owned, secret-free by contract,
 * and it is the only component that knows what its child needs in order to read
 * back the credentials it just materialized. Its environment is therefore
 * delivered as published, minus the provider's explicit credential variables.
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
    // A name-based admit-list here made the harness re-declare what each client
    // publishes, and it drifted: Claude Code's lease publishes the macOS
    // Keychain account (USER) its credentials were written under, the list
    // dropped it, and the child fell back to whatever ambient USER survived.
    // Probe evidence must not depend on ambient developer state, so the lease
    // environment is admitted whole — the same way the production seam merges
    // it into a spawned client. Credential variables stay refused so a
    // native-login probe can never be rescued by a credential and still be
    // recorded as native-login evidence.
    const providerCredentialVars = PROVIDER_CREDENTIAL_VARS[provider];
    for (const [name, value] of Object.entries(nativeAuthEnv)) {
      if (value && providerCredentialVars[name] === undefined) env[name] = value;
    }
  }
  env[configIsolationEnvVar] = tempConfigDir;
  return env;
}

/**
 * Flags the Claude Code builder sets itself; a scenario may not restate them.
 */
const CLAUDE_CODE_RESERVED_FLAGS = [
  '--print',
  '--output-format',
  '--max-turns',
  '--max-budget-usd',
  '--no-session-persistence',
  '--settings',
  '--setting-sources',
  '--permission-mode',
  '--allowedTools',
  '--add-dir',
] as const;

/**
 * Tokens the Codex builder sets itself; a scenario may not restate them.
 *
 * `--config` is deliberately absent: Codex takes it repeatedly and scenario-owned
 * configuration is how an event such as automatic compaction is reached at all.
 */
const CODEX_RESERVED_FLAGS = [
  'exec',
  '--json',
  '--ephemeral',
  '--sandbox',
  '--cd',
  '--skip-git-repo-check',
  '--dangerously-bypass-hook-trust',
] as const;

/**
 * Returns the scenario's extra CLI arguments, refusing harness-owned flags.
 *
 * Scenario arguments are appended after the builder's own, so a restated flag
 * would silently win over the bound the harness relies on — `--max-turns 2`
 * being the one that makes a committed exit code readable. Evidence produced
 * under a bound the fixture does not describe is worse than no evidence, so
 * this throws rather than dropping the argument.
 * @param scenario - Scenario carrying optional provider-native arguments.
 * @param reserved - Tokens this provider's builder owns.
 * @returns The scenario-owned arguments, unchanged.
 */
function scenarioCliArgs(scenario: ProbeScenario, reserved: readonly string[]): readonly string[] {
  const args = scenario.cliArgs ?? [];
  for (const arg of args) {
    const token = arg.startsWith('--') ? arg.split('=')[0]! : arg;
    if (reserved.includes(token)) {
      throw new Error(`Scenario "${scenario.id}" may not pass harness-owned argument "${token}" through cliArgs`);
    }
  }
  return args;
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
      // One turn to act, one to answer — uniformly, for every scenario.
      // A per-oracle bound made the committed exit code ambiguous: a scenario
      // whose model spent its only turn on a tool call ended in Claude's
      // documented `error_max_turns` result and exited 1, indistinguishable in
      // the fixture from a CLI that genuinely failed. Evidence has to be able
      // to assert a clean exit, so no scenario is cut off mid-turn.
      '--max-turns',
      '2',
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
      ...scenarioCliArgs(scenario, CLAUDE_CODE_RESERVED_FLAGS),
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
      // Scenario-owned configuration precedes the positional prompt, which
      // `codex exec` requires last.
      ...scenarioCliArgs(scenario, CODEX_RESERVED_FLAGS),
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
