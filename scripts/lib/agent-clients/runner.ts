/** @packageDocumentation */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawnOptionsForOwnership } from '@makaio/subprocess';
import { boundedByDeadline, buildSpawnCommand } from './command-construction.js';
import type { ScenarioInvocation } from './command-construction.js';
import { fixtureFilePath, readFixture, writeFixture } from './fixtures.js';
import { CLEANUP_COMPLETE, killProcessTree, terminateSpawned, type RunCleanup } from './process-tree-cleanup.js';
import {
  evaluateOracle,
  finalResponseContainsMarker,
  firedWithRequiredPayloadKeys,
  isProjectMarker,
  markerAbsent,
  markerPresent,
  noCompletedAgentOrToolOutput,
} from './oracle-signals.js';
import { redactDeep } from './redaction.js';
import type {
  CapturedHookInvocation,
  ProbeOptions,
  ProbeScenario,
  ScenarioFixture,
  TerminalClassification,
} from './types.js';
import type { ProbeWorkspace } from './workspace.js';

/** Result of one spawned scenario. */
export interface ScenarioRunResult {
  readonly fixture: ScenarioFixture;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** What the run knows about the processes the provider started; see {@link RunCleanup}. */
  readonly cleanup: RunCleanup;
}

/**
 * Quotes one opaque filesystem path for a provider's shell hook command.
 * @param value - The path to quote.
 * @returns A POSIX shell-safe token.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Resolves the provider-native isolated hook configuration file.
 * @param provider - Provider whose configuration format is selected.
 * @param workspace - Temporary workspace that owns the isolated config directory.
 * @returns The native configuration path.
 */
function nativeConfigPath(provider: ProbeOptions['provider'], workspace: ProbeWorkspace): string {
  return provider === 'claude-code'
    ? path.join(workspace.configDir, 'settings.json')
    : path.join(workspace.configDir, 'hooks.json');
}

/**
 * Writes native hook configuration that invokes the disposable capture shim.
 * @param params - Provider, scenario, and isolated workspace used to construct the hook command.
 * @returns The native settings path, disposable raw capture path, and the
 *   Claude Code `--mcp-config` path when a Claude Code scenario declares `mcpServers`.
 */
export async function writeScenarioHookConfig(params: {
  provider: ProbeOptions['provider'];
  scenario: ProbeScenario;
  workspace: ProbeWorkspace;
}): Promise<{ settingsPath: string; capturePath: string; mcpConfigPath?: string }> {
  const { provider, scenario, workspace } = params;
  const event = scenario.expectedEvents[0];
  if (!event) throw new Error(`Scenario "${scenario.id}" does not declare an event`);
  const capturePath = path.join(workspace.rootDir, `${scenario.id}.captures.jsonl`);
  const sentinelPath = path.join(workspace.rootDir, `${scenario.id}.sentinel`);
  const shimPath = path.join(workspace.rootDir, `${scenario.id}.hook-shim.cjs`);
  await fs.writeFile(sentinelPath, scenario.sentinelOutput ?? '', 'utf8');
  await fs.writeFile(
    shimPath,
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst [capture, sentinel, event] = process.argv.slice(2);\nlet input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => { input += chunk; });\nprocess.stdin.on('end', () => {\n  let parsed;\n  try { parsed = JSON.parse(input); } catch { parsed = { invalidJson: true }; }\n  const output = fs.readFileSync(sentinel, 'utf8');\n  const stopContinuation = event === 'Stop' && parsed && typeof parsed === 'object' && parsed.stop_hook_active === true;\n  const sentinelInjected = output.length > 0 && !stopContinuation;\n  fs.appendFileSync(capture, JSON.stringify({ eventName: event, input: parsed, sentinelInjected }) + '\\n');\n  if (sentinelInjected) process.stdout.write(output);\n});\n`,
    { mode: 0o700 },
  );
  const command = `${shellQuote(shimPath)} ${shellQuote(capturePath)} ${shellQuote(sentinelPath)} ${shellQuote(event.eventName)}`;
  const settingsPath = nativeConfigPath(provider, workspace);
  const contents =
    provider === 'claude-code'
      ? {
          hooks: {
            [event.eventName]: [
              {
                ...(scenario.hookMatcher !== undefined && { matcher: scenario.hookMatcher }),
                // Claude Code reads hook `timeout` in seconds, like Codex's `timeoutSec`.
                hooks: [{ type: 'command', command, timeout: scenario.timeoutSeconds }],
              },
            ],
          },
        }
      : {
          hooks: {
            [event.eventName]: [
              {
                // Codex hooks.json groups take the same optional `matcher` as Claude Code.
                ...(scenario.hookMatcher !== undefined && { matcher: scenario.hookMatcher }),
                hooks: [{ type: 'command', command, timeoutSec: scenario.timeoutSeconds }],
              },
            ],
          },
        };
  await fs.writeFile(settingsPath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  // Codex has no MCP config file; its servers travel as `--config` overrides built from the scenario.
  if (scenario.mcpServers === undefined || provider !== 'claude-code') return { settingsPath, capturePath };
  const mcpConfigPath = path.join(workspace.rootDir, `${scenario.id}.mcp-config.json`);
  await fs.writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: scenario.mcpServers }, null, 2)}\n`, 'utf8');
  return { settingsPath, capturePath, mcpConfigPath };
}

/** Upper bound for the exit and the closing pipes after the hard-deadline kill. */
const POST_KILL_SETTLE_MS = 5_000;

/**
 * The default tree termination of a platform.
 * @param platform - Platform whose termination rules apply.
 * @returns {@link killProcessTree} bound to the platform.
 */
function terminationFor(platform: NodeJS.Platform): (pid: number, exitObserved: boolean) => Promise<RunCleanup> {
  return (pid, exitObserved) => killProcessTree(pid, exitObserved, platform);
}

/** Timing and termination of {@link runCommand}; the defaults are the probe driver's own. */
export interface RunCommandOptions {
  /**
   * Time the exit and the closing pipes get once the tree termination has
   * finished. Default: {@link POST_KILL_SETTLE_MS}.
   */
  readonly postKillSettleMs?: number;
  /**
   * Terminates the provider process and what it started, or reports why it
   * could not; must be bounded. Default: {@link killProcessTree}. A run waits
   * for it to finish before its post-kill settle time starts, so a slow
   * termination (a `taskkill` on Windows, a quiescence proof) never eats into
   * the time the exit and the pipes are given. It must not signal a POSIX
   * group once `exitObserved` is `true`.
   */
  readonly terminateTree?: (pid: number, exitObserved: boolean) => Promise<RunCleanup>;
  /**
   * Platform whose termination rules the default {@link killProcessTree} applies.
   * Default: the host's. A seam for tests that simulate Windows on a POSIX host.
   */
  readonly platform?: NodeJS.Platform;
}

/**
 * Spawns one CLI in a process group and enforces its hard deadline.
 *
 * Every phase is bounded. When the child ends before the deadline, its group's
 * quiescence is proven (observed, never signalled: the exit is observed) before
 * the run returns, since a descendant with redirected stdio outlives the leader's
 * `close`. Windows has no such proof and can no longer address the tree of an
 * exited provider, so there the cleanup is `incomplete` (`tree-not-addressable`).
 * At the deadline the run is marked timed out and the tree is terminated (or,
 * once the provider's exit was observed, only observed; see
 * {@link killProcessTree}). The run never ends before that termination has finished, not
 * even when the provider exits by itself meanwhile, and a termination that
 * fails fails the run. Once it has finished, the exit and the closing
 * pipes get {@link POST_KILL_SETTLE_MS}. A pipe still held after that (by a
 * descendant that left the process group, or one that outlived a provider whose
 * exit was observed before the deadline, since a group is not signalled after
 * that) is released, and the output captured so far is returned: a timed-out
 * run's output is partial by definition, and the result's `cleanup` is
 * `incomplete` (`pipes-held`) instead of silently succeeding. An exit that is
 * still unobserved then fails the run instead of returning a result. Every end
 * (a result, a failed spawn, a failed kill, an unobserved exit) goes through one
 * settlement that clears the timers and releases the pipes; a child whose exit
 * was not observed is unreferenced, so it cannot keep the host alive.
 * @param command - Provider command including environment, cwd, and deadline.
 * @param options - Post-kill settle time and tree termination; see {@link RunCommandOptions}.
 * @returns Exit state, bounded stdout/stderr capture and what is known about the
 *   processes the provider started (`cleanup`).
 */
export async function runCommand(
  command: ReturnType<typeof buildSpawnCommand>,
  options: RunCommandOptions = {},
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cleanup: RunCleanup;
}> {
  const { postKillSettleMs = POST_KILL_SETTLE_MS, platform = process.platform } = options;
  const { terminateTree = terminationFor(platform) } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: command.env,
      ...spawnOptionsForOwnership('process-group'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const exitObserved = (): boolean => child.exitCode !== null || child.signalCode !== null;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    /** The tree termination the hard deadline started; defined from then on, and every end joins it. */
    let termination: Promise<void> | undefined;
    /** What the termination reported; `incomplete` is widened to `pipes-held` when a pipe stays held. */
    let cleanup: RunCleanup = CLEANUP_COMPLETE;
    /**
     * End the run once: clear the timers, release the pipes, and unreference a
     * child whose exit was not observed. A later event finds the run settled.
     * @param outcome - The exit code to resolve with, or the error to reject with.
     * @param heldPipes - Whether a pipe was still held when the run was cut off.
     */
    const settle = (
      outcome: { readonly exitCode: number | null } | { readonly error: Error },
      heldPipes = false,
    ): void => {
      if (settled) return;
      settled = true;
      if (heldPipes && cleanup.kind === 'complete') cleanup = { kind: 'incomplete', reason: 'pipes-held' };
      clearTimeout(timer);
      clearTimeout(settleTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (!exitObserved()) child.unref();
      if ('error' in outcome) reject(outcome.error);
      else resolve({ exitCode: outcome.exitCode, stdout, stderr, timedOut, cleanup });
    };
    /**
     * Start the tree termination, once.
     * @returns The pending termination.
     */
    const startTermination = (): Promise<void> => {
      clearTimeout(timer);
      termination = terminateSpawned(child.pid, exitObserved(), terminateTree).then((reported) => {
        cleanup = reported;
      });
      return termination;
    };
    /**
     * End the run with the failure of the tree termination.
     * @param thrown
     */
    const failTermination = (thrown: unknown): void =>
      settle({ error: thrown instanceof Error ? thrown : new Error(String(thrown)) });
    /**
     * End the run because the child closed or failed, once the tree termination
     * the hard deadline started has finished: the caller removes the workspace
     * the descendants may still write to as soon as the run returns. A failed
     * termination ends the run with its failure, not with the child's outcome.
     * @param outcome - What the child's own event reported.
     */
    const endRun = (outcome: { readonly exitCode: number | null } | { readonly error: Error }): void => {
      // Every platform reports what it knows about the tree of an exited provider.
      termination ??= startTermination();
      termination.then(() => settle(outcome), failTermination);
    };
    /** Give the exit and the closing pipes their bounded time; started once the tree termination finished. */
    const awaitSettlement = (): void => {
      if (settled) return;
      settleTimer = setTimeout(() => {
        // The exit is observed while a pipe is still held (by a descendant that
        // left the group): the captured output is returned as it is.
        if (exitObserved()) {
          settle({ exitCode: child.exitCode }, true);
          return;
        }
        settle({
          error: new Error(
            `Provider process ${String(child.pid)} did not exit within ${postKillSettleMs}ms of its kill`,
          ),
        });
      }, postKillSettleMs);
    };
    const timer = setTimeout(() => {
      if (termination !== undefined) return;
      timedOut = true;
      // The settle time starts only after the termination finished: a termination
      // that takes long (a bounded `taskkill`, a quiescence proof) must not use it up.
      // A tree that could not be killed may never close, so that failure ends the run.
      startTermination().then(awaitSettlement, failTermination);
    }, command.timeoutMs);
    child.once('error', (error) => endRun({ error }));
    child.once('close', (exitCode) => endRun({ exitCode }));
  });
}

/**
 * Reads raw shim records from the disposable workspace.
 * @param capturePath - JSONL file created by the temporary hook shim.
 * @returns Parsed native hook invocations, or no records when no hook fired.
 */
async function capturesAt(capturePath: string): Promise<readonly CapturedHookInvocation[]> {
  try {
    const content = await fs.readFile(capturePath, 'utf8');
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CapturedHookInvocation);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Evaluates the scenario-specific native response-consumption proof.
 * @param params - Provider output, marker workspace, and observed hook state.
 * @returns Whether the observed native behavior satisfies the scenario oracle.
 */
function responseWasConsumed(params: {
  provider: ProbeOptions['provider'];
  scenario: ProbeScenario;
  exitCode: number | null;
  timedOut: boolean;
  projectDir: string;
  stdout: string;
  invocationPayloadKeys: readonly (readonly string[])[];
  sentinelInjected: boolean;
}): boolean {
  const { provider, scenario, exitCode, timedOut, projectDir, stdout, invocationPayloadKeys, sentinelInjected } =
    params;
  if (timedOut || !firedWithRequiredPayloadKeys(scenario.requiredPayloadKeys, invocationPayloadKeys)) return false;
  // A negative control that declares a sentinel proves the refusal survives that sentinel, so a
  // run where the shim never injected it is no proof; one without a sentinel keeps the marker check alone.
  if (scenario.sentinelEffect !== undefined && !sentinelInjected) return false;
  if (scenario.oracle === 'native-must-deny-unapproved-tool') {
    return markerAbsent(projectDir, scenario.expectedAbsentMarker);
  }
  if (!sentinelInjected) return false;
  switch (scenario.oracle) {
    case 'sentinel-must-block-tool':
      return markerAbsent(projectDir, scenario.expectedAbsentMarker);
    case 'sentinel-must-allow-tool':
      return markerPresent(projectDir, scenario.expectedPresentMarker);
    case 'sentinel-must-rewrite-tool':
      return (
        markerPresent(projectDir, scenario.expectedPresentMarker) &&
        markerAbsent(projectDir, scenario.expectedAbsentMarker)
      );
    case 'final-response-must-contain-marker':
      return finalResponseContainsMarker(provider, stdout, scenario.expectedResponseMarker);
    case 'sentinel-must-block-before-model':
      return (
        exitCode === 0 &&
        markerAbsent(projectDir, scenario.expectedAbsentMarker) &&
        noCompletedAgentOrToolOutput(provider, stdout)
      );
    default:
      return false;
  }
}

/**
 * Projects disposable captures into stable, non-sensitive fixture evidence.
 * @param params - Native captures, scenario contract, and process outcome.
 * @returns Normalized evidence suitable for fixture comparison.
 */
function normalizedFixture(params: {
  provider: ProbeOptions['provider'];
  scenario: ProbeScenario;
  cliVersion: string;
  captures: readonly CapturedHookInvocation[];
  exitCode: number | null;
  timedOut: boolean;
  projectDir: string;
  stdout: string;
}): ScenarioFixture {
  const { provider, scenario, cliVersion, captures, exitCode, timedOut, projectDir, stdout } = params;
  const event = scenario.expectedEvents[0]!;
  const matching = captures.filter((capture) => capture.eventName === event.eventName);
  const hookFired = matching.length > 0;
  const sentinelInjected = matching.some((capture) => capture.sentinelInjected);
  const invocationPayloadKeys = matching.map(capturePayloadKeys);
  const terminal = classifyTerminal({ provider, exitCode, timedOut, stdout });
  const responseConsumed = responseWasConsumed({
    provider,
    scenario,
    exitCode,
    timedOut,
    projectDir,
    stdout,
    invocationPayloadKeys,
    sentinelInjected,
  });
  const oraclePassed = evaluateOracle({ scenario, terminal, hookFired, responseConsumed });
  return {
    schemaVersion: 4,
    provider,
    cliVersion,
    scenarioId: scenario.id,
    events: hookFired
      ? [
          {
            eventName: event.eventName,
            ...(event.frameworkSubject ? { frameworkSubject: event.frameworkSubject } : {}),
            responseCapabilities: event.responseCapabilities,
            mode: event.mode,
            candidateExpectedStatus: scenario.candidateExpectedStatus,
            observedStatus: responseConsumed ? 'supported' : 'observer-only',
            sourceExpectedEffects: scenario.sourceExpectedEffects,
            // The negative control proves its sentinel changed nothing, not that the sentinel's effect was
            // consumed, so it records no observed effect; the event's own context-append scenario owns that proof.
            observedEffects:
              responseConsumed && scenario.sentinelEffect && scenario.oracle !== 'native-must-deny-unapproved-tool'
                ? [scenario.sentinelEffect]
                : [],
            blockingCapable: scenario.blockingCapable,
            managedCommand: scenario.expectedManagedCommand,
            payloadKeys: [...new Set(invocationPayloadKeys.flat())].sort(),
            sentinelInjected,
          },
        ]
      : [],
    oracle: scenario.oracle,
    oraclePassed,
    exitCode,
    terminal,
  };
}

/**
 * Reads the stable top-level payload keys from one raw native invocation.
 * @param capture - Disposable raw hook invocation.
 * @returns Redacted top-level payload keys.
 */
function capturePayloadKeys(capture: CapturedHookInvocation): readonly string[] {
  return capture.input && typeof capture.input === 'object' && !Array.isArray(capture.input)
    ? Object.keys(redactDeep(capture.input) as Record<string, unknown>)
    : [];
}

/**
 * Classifies how one native run terminated, once, for the committed evidence.
 *
 * Parsing a provider's machine-readable terminal result belongs here and not in
 * an oracle: the oracle then reads a persisted classification that every
 * fixture carries, and a reader of committed evidence can tell a documented
 * bounded-turn end from a failure without re-running the binary.
 * @param params - Provider, process outcome, and complete bounded CLI stdout.
 * @returns The terminal classification persisted with the fixture.
 */
function classifyTerminal(params: {
  provider: ProbeOptions['provider'];
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
}): TerminalClassification {
  const { provider, exitCode, timedOut, stdout } = params;
  if (timedOut || exitCode === null) return 'killed';
  if (exitCode === 0) return 'ok';
  return isMaxTurnsResult(provider, stdout) ? 'error_max_turns' : 'error';
}

/**
 * Recognizes a provider's documented bounded-turn terminal result without admitting unrelated failures.
 * @param provider - Provider whose machine-readable output format is parsed.
 * @param stdout - Complete bounded CLI stdout.
 * @returns Whether stdout is exactly a max-turn exhaustion result.
 */
function isMaxTurnsResult(provider: ProbeOptions['provider'], stdout: string): boolean {
  if (provider !== 'claude-code') return false;
  try {
    const result = JSON.parse(stdout) as Record<string, unknown>;
    return result.type === 'result' && result.subtype === 'error_max_turns' && result.is_error === true;
  } catch {
    return false;
  }
}

/**
 * Removes scenario-owned markers before a fresh native execution.
 * @param projectDir - Disposable project root.
 * @param scenario - Scenario declaring marker assertions.
 * @returns A promise resolved when all valid scenario markers are absent.
 */
async function resetScenarioMarkers(projectDir: string, scenario: ProbeScenario): Promise<void> {
  const markers = [scenario.expectedPresentMarker, scenario.expectedAbsentMarker].filter(isProjectMarker);
  await Promise.all([...new Set(markers)].map((marker) => fs.rm(path.join(projectDir, marker), { force: true })));
}

/**
 * Reads the session identifier a completed print-mode run reports.
 * @param stdout - Complete bounded CLI stdout.
 * @returns The reported session identifier, or nothing when stdout carries none.
 */
function reportedSessionId(stdout: string): string | undefined {
  try {
    const result = JSON.parse(stdout) as Record<string, unknown>;
    return typeof result.session_id === 'string' && result.session_id.length > 0 ? result.session_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the conversation a seeded scenario needs before its own prompt runs.
 *
 * Only the run under test may leave captures behind, so the seed's are
 * discarded: a fixture has to describe one native run, and a reader cannot tell
 * from committed evidence which of two runs invoked a hook.
 * @param params - Scenario execution inputs, the scenario's native config path, and its absolute deadline.
 * @returns The invocation that resumes the seeded session, or nothing when the scenario is not seeded.
 */
async function seedResumableSession(params: {
  provider: ProbeOptions['provider'];
  scenario: ProbeScenario;
  executablePath: string;
  env: Record<string, string>;
  projectDir: string;
  settingsPath: string;
  mcpConfigPath?: string;
  capturePath: string;
  deadlineMs: number;
}): Promise<ScenarioInvocation | undefined> {
  if (params.scenario.seedPrompt === undefined) return undefined;
  const command = buildSpawnCommand({ ...params, invocation: { seed: true } });
  const result = await runCommand(boundedByDeadline(command, params.deadlineMs, Date.now()));
  const resumeSessionId = reportedSessionId(result.stdout);
  if (result.timedOut || result.exitCode !== 0 || resumeSessionId === undefined) {
    throw new Error(
      `Scenario "${params.scenario.id}" could not seed a resumable session (exit ${String(result.exitCode)})`,
    );
  }
  await fs.rm(params.capturePath, { force: true });
  return { resumeSessionId };
}

/**
 * Runs one native scenario and applies its fixture mode.
 * @param params - Scenario execution inputs, including isolated environment and fixture mode.
 * @returns Process output, normalized fixture, and any verification differences.
 */
export async function runScenario(params: {
  provider: ProbeOptions['provider'];
  scenario: ProbeScenario;
  cliVersion: string;
  executablePath: string;
  env: Record<string, string>;
  workspace: ProbeWorkspace;
  fixturesDir: string;
  updateFixtures: boolean;
}): Promise<ScenarioRunResult & { fixtureDiffs: readonly string[] }> {
  await resetScenarioMarkers(params.workspace.projectDir, params.scenario);
  const config = await writeScenarioHookConfig(params);
  const commandParams = {
    provider: params.provider,
    executablePath: params.executablePath,
    scenario: params.scenario,
    env: params.env,
    projectDir: params.workspace.projectDir,
    settingsPath: config.settingsPath,
    ...(config.mcpConfigPath !== undefined && { mcpConfigPath: config.mcpConfigPath }),
  };
  // One deadline for the whole scenario, fixed before the first spawn, so a
  // seeded scenario's two runs share the budget instead of each taking it.
  const deadlineMs = Date.now() + params.scenario.timeoutSeconds * 1000;
  const invocation = await seedResumableSession({ ...commandParams, capturePath: config.capturePath, deadlineMs });
  const command = buildSpawnCommand({ ...commandParams, ...(invocation ? { invocation } : {}) });
  const commandResult = await runCommand(boundedByDeadline(command, deadlineMs, Date.now()));
  const fixture = normalizedFixture({
    provider: params.provider,
    scenario: params.scenario,
    cliVersion: params.cliVersion,
    captures: await capturesAt(config.capturePath),
    exitCode: commandResult.exitCode,
    timedOut: commandResult.timedOut,
    projectDir: params.workspace.projectDir,
    stdout: commandResult.stdout,
  });
  const filePath = fixtureFilePath({
    baseDir: params.fixturesDir,
    provider: params.provider,
    scenarioId: params.scenario.id,
  });
  if (params.updateFixtures) {
    await writeFixture({ baseDir: params.fixturesDir, fixture });
    return { ...commandResult, fixture, fixtureDiffs: [] };
  }
  const committed = await readFixture(filePath);
  const { compareFixtures } = await import('./fixtures.js');
  const fixtureDiffs = committed ? compareFixtures({ recorded: fixture, committed }) : [`Missing fixture: ${filePath}`];
  return { ...commandResult, fixture, fixtureDiffs };
}
