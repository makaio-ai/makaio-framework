#!/usr/bin/env tsx
/**
 * Paid, explicit native agent-client conformance probe.
 *
 * This entry point is deliberately excluded from normal tests and validation.
 * It runs one provider only, leases the client's inferred native login unless
 * one explicit process credential is selected, and stores only normalized hook
 * evidence from an isolated temporary workspace.
 * @packageDocumentation
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildChildEnvironment,
  cleanupProbeWorkspace,
  createProbeWorkspace,
  FIXTURES_BASE_DIR,
  getConfigIsolationEnvVar,
  getManifest,
  getPinnedVersion,
  getVersionCommand,
  publishProbeEvidence,
  preparePinnedProbeBinary,
  prepareNativeLoginLease,
  resolveCredentialMode,
  runScenario,
  validateBinaryVersion,
} from './lib/agent-clients/index.js';
import { summarizeNativeResult } from './lib/agent-clients/native-result-summary.js';
import type {
  NativeLoginLeaseFactory,
  PreparedProbeBinary,
  ProbeOptions,
  ProbeScenario,
  ProviderId,
  ScenarioFixture,
  ScenarioManifest,
} from './lib/agent-clients/index.js';

/** Default `--max-scenarios` cap; every provider manifest must fit within it. */
export const DEFAULT_MAX_SCENARIOS = 20;
// 1200 s: the Claude manifest runs 17 scenarios with timeouts of up to 60 s each, which
// exceeds the former 300 s budget (FACT-88 adds the MCP PostToolUse scenario).
const DEFAULT_MAX_WALL_CLOCK_SECONDS = 1200;
const VALID_PROVIDERS = new Set<ProviderId>(['claude-code', 'codex']);
const USAGE = `Usage: yarn test:agent-clients --provider <claude-code|codex> [options]

Options:
  --scenario <id>          Run only this scenario; repeat to run several (verify mode only)
  --max-scenarios <n>      Run at most n scenarios (default ${String(DEFAULT_MAX_SCENARIOS)})
  --max-wall-clock <s>     Stop starting scenarios after s seconds (default ${String(DEFAULT_MAX_WALL_CLOCK_SECONDS)})
  --update-fixtures        Record and publish fixtures; requires every scenario (no --scenario filter)
  --help                   Show this help`;

/** Probe options plus the optional CLI scenario filter. */
export type ProbeCliOptions = ProbeOptions & {
  /** Scenario ids to run, in manifest order; absent runs every scenario. */
  readonly scenarioIds?: readonly string[];
};

/**
 * Selects the manifest scenarios named by a `--scenario` filter, in manifest order.
 * @param manifest - Provider manifest the ids are resolved against.
 * @param scenarioIds - Requested ids; absent selects every scenario.
 * @returns The selected scenarios.
 */
export function selectScenarios(
  manifest: ScenarioManifest,
  scenarioIds: readonly string[] | undefined,
): readonly ProbeScenario[] {
  if (scenarioIds === undefined) return manifest.scenarios;
  const valid = manifest.scenarios.map((scenario) => scenario.id);
  const unknown = scenarioIds.filter((id) => !valid.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown --scenario for ${manifest.provider}: ${unknown.join(', ')}. Valid ids: ${valid.join(', ')}`,
    );
  }
  const requested = new Set(scenarioIds);
  return manifest.scenarios.filter((scenario) => requested.has(scenario.id));
}

/**
 * Resolves the scenarios a probe run will attempt: the `--scenario` selection capped by `--max-scenarios`.
 * @param manifest - Provider manifest the selection is resolved against.
 * @param options - Scenario filter and scenario cap of this run.
 * @returns The planned scenarios, in manifest order.
 */
export function plannedScenarios(
  manifest: ScenarioManifest,
  options: Pick<ProbeCliOptions, 'scenarioIds' | 'maxScenarios'>,
): readonly ProbeScenario[] {
  return selectScenarios(manifest, options.scenarioIds).slice(0, options.maxScenarios);
}

/**
 * Finds source-expected event/effect pairs not proven by live behavior fixtures.
 * @param manifest - Scenarios defining the required source surface: the complete manifest when
 * publishing, the planned scenarios of a verify run.
 * @param fixtures - Fresh fixtures from the scenarios executed by this probe.
 * @returns Stable sorted event/effect keys missing behavioral evidence.
 */
export function findMissingEffectCoverage(
  manifest: Pick<ScenarioManifest, 'scenarios'>,
  fixtures: readonly ScenarioFixture[],
): readonly string[] {
  const required = new Set<string>();
  for (const scenario of manifest.scenarios) {
    const event = scenario.expectedEvents[0];
    if (!event) continue;
    for (const effect of scenario.sourceExpectedEffects) required.add(`${event.eventName}:${effect}`);
  }
  const observed = new Set<string>();
  for (const fixture of fixtures) {
    for (const event of fixture.events) {
      for (const effect of event.observedEffects) observed.add(`${event.eventName}:${effect}`);
    }
  }
  return [...required].filter((key) => !observed.has(key)).sort();
}

/**
 * Resolves canonical provider-owned probe fixture storage from this entry point,
 * independent of whether it is invoked from a full checkout or framework root.
 * @param scriptPath - Absolute path to `test-agent-clients.ts`.
 * @returns Framework `clients` directory containing hook-contract fixtures.
 */
export function resolveDefaultFixturesDir(scriptPath: string): string {
  return path.resolve(path.dirname(scriptPath), '..', FIXTURES_BASE_DIR);
}

/**
 * Parses the intentionally small paid-probe CLI surface.
 * @param args - Command-line arguments after the script name.
 * @param env - Process environment used only for credential selection.
 * @returns Validated, bounded probe options.
 */
export function parseProbeArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): ProbeCliOptions {
  let provider: ProviderId | undefined;
  let updateFixtures = false;
  const scenarioIds: string[] = [];
  let maxScenarios = DEFAULT_MAX_SCENARIOS;
  let maxWallClockSeconds = DEFAULT_MAX_WALL_CLOCK_SECONDS;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--provider') {
      const value = args[++index];
      if (!value || !VALID_PROVIDERS.has(value as ProviderId))
        throw new Error('--provider must be claude-code or codex');
      provider = value as ProviderId;
    } else if (arg === '--scenario') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('--scenario requires a scenario id');
      scenarioIds.push(value);
    } else if (arg === '--update-fixtures') {
      updateFixtures = true;
    } else if (arg === '--max-scenarios' || arg === '--max-wall-clock') {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${arg} must be a positive integer`);
      if (arg === '--max-scenarios') maxScenarios = value;
      else maxWallClockSeconds = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!provider) throw new Error('--provider is required');
  // Fails fast on an unknown id, before any credential or binary work.
  if (scenarioIds.length > 0) selectScenarios(getManifest(provider), scenarioIds);
  const credentials = resolveCredentialMode({ provider, env });
  if (!credentials.mode) throw new Error(credentials.error);
  return {
    provider,
    credentialMode: credentials.mode,
    updateFixtures,
    maxScenarios,
    maxWallClockSeconds,
    ...(scenarioIds.length > 0 && { scenarioIds }),
  };
}

/**
 * Executes all bounded scenarios for one provider.
 * @param options - Explicit provider, credential mode, and bounded execution limits.
 * @param params - Test-only executable, fixture-directory, and native-login overrides.
 * @returns Aggregate result without changing process exit state.
 */
export async function runProbe(
  options: ProbeCliOptions,
  params?: {
    /** Exact executable override reserved for injected tests. */
    executablePath?: string;
    fixturesDir?: string;
    nativeLoginLeaseFactory?: NativeLoginLeaseFactory;
    validateBinaryVersion?: typeof validateBinaryVersion;
    runScenario?: typeof runScenario;
    preparePinnedBinary?: typeof preparePinnedProbeBinary;
  },
): Promise<{
  readonly passed: boolean;
  readonly scenariosExecuted: number;
  readonly failures: readonly string[];
}> {
  const manifest = getManifest(options.provider);
  const scenarios = plannedScenarios(manifest, options);
  if (options.updateFixtures && scenarios.length < manifest.scenarios.length) {
    return {
      passed: false,
      scenariosExecuted: 0,
      failures: [
        `Refusing to publish partial evidence: --update-fixtures must cover all ${String(manifest.scenarios.length)} scenarios (no --scenario filter, --max-scenarios >= ${String(manifest.scenarios.length)})`,
      ],
    };
  }
  const workspace = await createProbeWorkspace({ provider: options.provider, manifest });
  let preparedBinary: PreparedProbeBinary | undefined;
  let nativeLoginLease: Awaited<ReturnType<typeof prepareNativeLoginLease>> | undefined;
  try {
    const versionCommand = getVersionCommand(options.provider);
    const pinnedVersion = getPinnedVersion(options.provider);
    const executablePath =
      params?.executablePath ??
      (preparedBinary = await (params?.preparePinnedBinary ?? preparePinnedProbeBinary)({ provider: options.provider }))
        .executablePath;
    const version = await (params?.validateBinaryVersion ?? validateBinaryVersion)({
      provider: options.provider,
      pinnedVersion,
      executable: executablePath,
      versionArgs: versionCommand.args,
    });
    if (!version.valid) throw new Error(`Version mismatch: ${version.error}`);

    const fixturesDir = params?.fixturesDir ?? resolveDefaultFixturesDir(fileURLToPath(import.meta.url));
    const stagedFixturesDir = path.join(workspace.rootDir, 'staged-fixtures');
    const startedAt = Date.now();
    const failures: string[] = [];
    const fixtures: ScenarioFixture[] = [];
    let scenariosExecuted = 0;
    if (options.credentialMode === 'native-login') {
      nativeLoginLease = await prepareNativeLoginLease({
        provider: options.provider,
        configDir: workspace.configDir,
        projectDir: workspace.projectDir,
        factory: params?.nativeLoginLeaseFactory,
      });
    }
    const childEnv = buildChildEnvironment({
      provider: options.provider,
      credentialMode: options.credentialMode,
      configIsolationEnvVar: getConfigIsolationEnvVar(options.provider),
      tempConfigDir: workspace.configDir,
      ...(nativeLoginLease ? { nativeAuthEnv: nativeLoginLease.env } : {}),
    });
    for (const scenario of scenarios) {
      const remainingMs = options.maxWallClockSeconds * 1000 - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        failures.push(`Wall-clock cap reached after ${String(scenariosExecuted)} scenario(s)`);
        break;
      }
      const boundedScenario = {
        ...scenario,
        timeoutSeconds: Math.min(scenario.timeoutSeconds, Math.ceil(remainingMs / 1000)),
      };
      const result = await (params?.runScenario ?? runScenario)({
        provider: options.provider,
        scenario: boundedScenario,
        cliVersion: pinnedVersion,
        executablePath,
        env: childEnv,
        workspace,
        fixturesDir: options.updateFixtures ? stagedFixturesDir : fixturesDir,
        updateFixtures: options.updateFixtures,
      });
      scenariosExecuted += 1;
      fixtures.push(result.fixture);
      if (!result.fixture.oraclePassed) {
        const diagnostic = summarizeNativeResult(result.stdout, result.stderr);
        failures.push(`${scenario.id}: native oracle failed${diagnostic ? ` (${diagnostic})` : ''}`);
      }
      failures.push(...result.fixtureDiffs.map((diff) => `${scenario.id}: ${diff}`));
    }
    // Publishing must prove the whole manifest; a verify run only owes evidence for the scenarios it
    // planned, so a --scenario or --max-scenarios subset is not failed for scenarios it skipped.
    const coverageScope = options.updateFixtures ? manifest : { scenarios };
    for (const missing of findMissingEffectCoverage(coverageScope, fixtures))
      failures.push(`Missing live behavior evidence for ${missing}`);
    if (options.updateFixtures && failures.length === 0 && scenariosExecuted === manifest.scenarios.length) {
      await publishProbeEvidence({
        baseDir: fixturesDir,
        stagedBaseDir: stagedFixturesDir,
        provider: options.provider,
        fixtures,
        capturedAt: new Date().toISOString(),
      });
    }
    return { passed: failures.length === 0 && scenariosExecuted > 0, scenariosExecuted, failures };
  } finally {
    try {
      if (nativeLoginLease) await nativeLoginLease.teardown();
    } finally {
      try {
        await cleanupProbeWorkspace(workspace);
      } finally {
        await preparedBinary?.cleanup();
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  try {
    const options = parseProbeArgs(args);
    const manifest = getManifest(options.provider);
    const scenarioCount = plannedScenarios(manifest, options).length;
    console.warn('WARNING: test:agent-clients makes credentialed, networked, potentially billable requests.');
    console.log(
      `provider=${options.provider} pinned=${manifest.pinnedVersion} scenarios=${String(scenarioCount)} mode=${options.updateFixtures ? 'update' : 'verify'}`,
    );
    const result = await runProbe(options);
    if (!result.passed) throw new Error(result.failures.join('\n'));
    console.log(`Passed ${String(result.scenariosExecuted)} scenario(s).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
