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
  redactStringValue,
  resolveCredentialMode,
  runScenario,
  validateBinaryVersion,
} from './lib/agent-clients/index.js';
import type {
  NativeLoginLeaseFactory,
  PreparedProbeBinary,
  ProbeOptions,
  ProviderId,
  ScenarioFixture,
  ScenarioManifest,
} from './lib/agent-clients/index.js';

const DEFAULT_MAX_SCENARIOS = 16;
const DEFAULT_MAX_WALL_CLOCK_SECONDS = 300;
const VALID_PROVIDERS = new Set<ProviderId>(['claude-code', 'codex']);

/**
 * Finds source-expected event/effect pairs not proven by live behavior fixtures.
 * @param manifest - Complete provider manifest defining the required source surface.
 * @param fixtures - Fresh fixtures from the scenarios executed by this probe.
 * @returns Stable sorted event/effect keys missing behavioral evidence.
 */
export function findMissingEffectCoverage(
  manifest: ScenarioManifest,
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
export function parseProbeArgs(args: readonly string[], env: NodeJS.ProcessEnv = process.env): ProbeOptions {
  let provider: ProviderId | undefined;
  let updateFixtures = false;
  let maxScenarios = DEFAULT_MAX_SCENARIOS;
  let maxWallClockSeconds = DEFAULT_MAX_WALL_CLOCK_SECONDS;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--provider') {
      const value = args[++index];
      if (!value || !VALID_PROVIDERS.has(value as ProviderId))
        throw new Error('--provider must be claude-code or codex');
      provider = value as ProviderId;
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
  const credentials = resolveCredentialMode({ provider, env });
  if (!credentials.mode) throw new Error(credentials.error);
  return { provider, credentialMode: credentials.mode, updateFixtures, maxScenarios, maxWallClockSeconds };
}

/**
 * Executes all bounded scenarios for one provider.
 * @param options - Explicit provider, credential mode, and bounded execution limits.
 * @param params - Test-only executable, fixture-directory, and native-login overrides.
 * @returns Aggregate result without changing process exit state.
 */
export async function runProbe(
  options: ProbeOptions,
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
  if (options.updateFixtures && options.maxScenarios < manifest.scenarios.length) {
    return {
      passed: false,
      scenariosExecuted: 0,
      failures: [
        `Refusing to publish partial evidence: --max-scenarios must cover all ${String(manifest.scenarios.length)} scenarios`,
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
    for (const scenario of manifest.scenarios.slice(0, options.maxScenarios)) {
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
        const diagnostic = redactStringValue([result.stdout, result.stderr].filter(Boolean).join(' '))
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 800);
        failures.push(`${scenario.id}: native oracle failed${diagnostic ? ` (${diagnostic})` : ''}`);
      }
      failures.push(...result.fixtureDiffs.map((diff) => `${scenario.id}: ${diff}`));
    }
    for (const missing of findMissingEffectCoverage(manifest, fixtures))
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
  try {
    const options = parseProbeArgs(process.argv.slice(2));
    const manifest = getManifest(options.provider);
    console.warn('WARNING: test:agent-clients makes credentialed, networked, potentially billable requests.');
    console.log(
      `provider=${options.provider} pinned=${manifest.pinnedVersion} scenarios=${String(Math.min(manifest.scenarios.length, options.maxScenarios))} mode=${options.updateFixtures ? 'update' : 'verify'}`,
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
