/** @packageDocumentation */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildSpawnCommand } from './command-construction.js';
import { fixtureFilePath, readFixture, writeFixture } from './fixtures.js';
import { redactDeep } from './redaction.js';
import type { CapturedHookInvocation, ProbeOptions, ProbeScenario, ScenarioFixture } from './types.js';
import type { ProbeWorkspace } from './workspace.js';

/** Result of one spawned scenario. */
export interface ScenarioRunResult {
  readonly fixture: ScenarioFixture;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
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
 * @returns The native settings path and disposable raw capture path.
 */
export async function writeScenarioHookConfig(params: {
  provider: ProbeOptions['provider'];
  scenario: ProbeScenario;
  workspace: ProbeWorkspace;
}): Promise<{ settingsPath: string; capturePath: string }> {
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
            [event.eventName]: [{ hooks: [{ type: 'command', command, timeout: scenario.timeoutSeconds * 1000 }] }],
          },
        }
      : {
          hooks: {
            [event.eventName]: [{ hooks: [{ type: 'command', command, timeoutSec: scenario.timeoutSeconds }] }],
          },
        };
  await fs.writeFile(settingsPath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  return { settingsPath, capturePath };
}

/**
 * Terminates the direct child and, on POSIX, every process in its process group.
 * @param child - Spawned provider process.
 * @returns A promise that resolves after a kill signal has been issued.
 */
async function killProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The child can exit between the timeout and group termination attempt.
    }
  }
  child.kill('SIGKILL');
}

/**
 * Spawns one CLI in a process group and enforces its hard deadline.
 * @param command - Provider command including environment, cwd, and deadline.
 * @returns Exit state and bounded stdout/stderr capture.
 */
export async function runCommand(command: ReturnType<typeof buildSpawnCommand>): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: command.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      void killProcessTree(child);
    }, command.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
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
  hookFired: boolean;
  sentinelInjected: boolean;
}): boolean {
  const { provider, scenario, exitCode, timedOut, projectDir, stdout, hookFired, sentinelInjected } = params;
  if (timedOut || !hookFired) return false;
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
  const responseConsumed = responseWasConsumed({
    provider,
    scenario,
    exitCode,
    timedOut,
    projectDir,
    stdout,
    hookFired,
    sentinelInjected,
  });
  const oraclePassed =
    scenario.oracle === 'unobserved'
      ? !timedOut && (exitCode === 0 || isClaudeMaxTurnsResult(provider, stdout))
      : scenario.oracle === 'capture-only'
        ? !timedOut && exitCode === 0 && hookFired && scenario.candidateExpectedStatus !== 'supported'
        : responseConsumed;
  return {
    schemaVersion: 3,
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
            observedEffects: responseConsumed && scenario.sentinelEffect ? [scenario.sentinelEffect] : [],
            blockingCapable: scenario.blockingCapable,
            managedCommand: scenario.expectedManagedCommand,
            payloadKeys: [...new Set(matching.flatMap(capturePayloadKeys))].sort(),
            sentinelInjected,
          },
        ]
      : [],
    oracle: scenario.oracle,
    oraclePassed,
    exitCode,
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
 * Resolves and checks a scenario-owned marker inside its disposable project.
 * @param projectDir - Disposable project root.
 * @param marker - Basename declared by the scenario.
 * @returns Whether the marker exists without accepting path traversal.
 */
function markerPresent(projectDir: string, marker: string | undefined): boolean {
  return isProjectMarker(marker) && existsSync(path.join(projectDir, marker));
}

/**
 * Resolves and checks absence of a scenario-owned marker.
 * @param projectDir - Disposable project root.
 * @param marker - Basename declared by the scenario.
 * @returns Whether the marker is valid and absent.
 */
function markerAbsent(projectDir: string, marker: string | undefined): boolean {
  return isProjectMarker(marker) && !existsSync(path.join(projectDir, marker));
}

/**
 * Validates a single scenario-owned filename without accepting the project root or traversal.
 * @param marker - Marker basename declared by a scenario.
 * @returns Whether the marker can safely be resolved below the disposable project.
 */
function isProjectMarker(marker: string | undefined): marker is string {
  return marker !== undefined && marker !== '' && marker !== '.' && marker !== '..' && path.basename(marker) === marker;
}

/**
 * Tests a marker only in the provider's structured final assistant response.
 * Raw hook stdout, diagnostics, and echoed command input are deliberately not evidence.
 * @param provider - Provider whose machine-readable output format is parsed.
 * @param stdout - Complete bounded CLI stdout.
 * @param marker - Unique marker injected through the hook response.
 * @returns Whether a final assistant response contains the marker.
 */
function finalResponseContainsMarker(
  provider: ProbeOptions['provider'],
  stdout: string,
  marker: string | undefined,
): boolean {
  if (!marker) return false;
  try {
    if (provider === 'claude-code') {
      const result = JSON.parse(stdout) as Record<string, unknown>;
      return result.type === 'result' && typeof result.result === 'string' && result.result.includes(marker);
    }
    return stdout
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== 'item.completed' || typeof event.item !== 'object' || event.item === null) return false;
        const item = event.item as Record<string, unknown>;
        return item.type === 'agent_message' && typeof item.text === 'string' && item.text.includes(marker);
      });
  } catch {
    return false;
  }
}

/**
 * Rejects a blocked-before-model proof when Codex reported a completed non-diagnostic item.
 * @param provider - Provider whose machine-readable output format is parsed.
 * @param stdout - Complete bounded CLI stdout.
 * @returns Whether completed items, if any, are only diagnostic errors.
 */
function noCompletedAgentOrToolOutput(provider: ProbeOptions['provider'], stdout: string): boolean {
  if (provider !== 'codex') return false;
  try {
    return !stdout
      .split('\n')
      .filter(Boolean)
      .some((line) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type !== 'item.completed' || typeof event.item !== 'object' || event.item === null) return false;
        return (event.item as Record<string, unknown>).type !== 'error';
      });
  } catch {
    return false;
  }
}

/**
 * Recognizes Claude's documented bounded-turn terminal result without admitting unrelated failures.
 * @param provider - Provider whose machine-readable output format is parsed.
 * @param stdout - Complete bounded CLI stdout.
 * @returns Whether stdout is exactly a Claude max-turn exhaustion result.
 */
function isClaudeMaxTurnsResult(provider: ProbeOptions['provider'], stdout: string): boolean {
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
  const command = buildSpawnCommand({
    provider: params.provider,
    executablePath: params.executablePath,
    scenario: params.scenario,
    env: params.env,
    projectDir: params.workspace.projectDir,
    settingsPath: config.settingsPath,
  });
  const commandResult = await runCommand(command);
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
