import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureFilePath, writeFixture } from '../lib/agent-clients/fixtures.js';
import { getManifest } from '../lib/agent-clients/manifests.js';
import type { runScenario } from '../lib/agent-clients/runner.js';
import type { CredentialMode, ProbeScenario, ProviderId, ScenarioFixture } from '../lib/agent-clients/types.js';
import { resolveDefaultFixturesDir, runProbe } from '../test-agent-clients.js';

const CREDENTIAL_MODE: Record<ProviderId, CredentialMode> = { 'claude-code': 'api-key', codex: 'access-token' };

/**
 * Builds the injected scenario runner: every scenario passes its oracle and records its sentinel
 * effect as observed, unless `observedEffects` overrides the recorded effects for that scenario.
 * @param provider - Provider the fixtures are recorded for.
 * @param options - Executed-id sink, observed-effect override, and whether to write staged fixtures.
 * @returns A `runScenario` replacement.
 */
function stubRunScenario(
  provider: ProviderId,
  options: {
    readonly executed: string[];
    readonly observedEffects?: (scenario: ProbeScenario) => readonly string[] | undefined;
    readonly writeStaged?: boolean;
  },
): typeof runScenario {
  return async (params) => {
    options.executed.push(params.scenario.id);
    const event = params.scenario.expectedEvents[0]!;
    const fixture: ScenarioFixture = {
      schemaVersion: 4,
      provider,
      cliVersion: getManifest(provider).pinnedVersion,
      scenarioId: params.scenario.id,
      events: [
        {
          ...event,
          candidateExpectedStatus: params.scenario.candidateExpectedStatus,
          observedStatus: params.scenario.sentinelEffect ? 'supported' : 'observer-only',
          sourceExpectedEffects: params.scenario.sourceExpectedEffects,
          observedEffects:
            options.observedEffects?.(params.scenario) ??
            (params.scenario.sentinelEffect ? [params.scenario.sentinelEffect] : []),
          blockingCapable: params.scenario.blockingCapable,
          managedCommand: params.scenario.expectedManagedCommand,
          payloadKeys: [],
          sentinelInjected: params.scenario.sentinelOutput !== undefined,
        },
      ],
      oracle: params.scenario.oracle,
      oraclePassed: true,
      exitCode: 0,
      terminal: 'ok',
    };
    if (options.writeStaged) await writeFixture({ baseDir: params.fixturesDir, fixture });
    return { fixture, fixtureDiffs: [], stdout: '', stderr: '', timedOut: false };
  };
}

/**
 * Event/effect key of a scenario's sentinel effect.
 * @param scenario - Scenario carrying a sentinel effect.
 * @returns The `<event>:<effect>` key.
 */
function effectKey(scenario: ProbeScenario): string {
  return `${scenario.expectedEvents[0]!.eventName}:${scenario.sentinelEffect!}`;
}

/**
 * The last manifest scenario with a sentinel effect whose event declares no other source effect.
 * @param provider - Provider whose manifest is searched.
 * @returns The scenario.
 */
function singleEffectScenario(provider: ProviderId): ProbeScenario {
  const scenario = getManifest(provider).scenarios.findLast(
    (candidate) => candidate.sentinelEffect !== undefined && candidate.sourceExpectedEffects.length === 1,
  );
  expect(scenario).toBeDefined();
  return scenario!;
}

describe('native probe verify-mode effect coverage', () => {
  async function withFixturesDir<T>(run: (fixturesDir: string) => Promise<T>): Promise<T> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-filtered-verify-'));
    try {
      return await run(path.join(root, 'clients'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it('passes a --scenario verify run on the selected scenario evidence alone', async () => {
    const provider = 'codex';
    const selected = singleEffectScenario(provider);
    // The filter is only meaningful when the rest of the manifest owes other evidence.
    expect(getManifest(provider).scenarios.some((scenario) => scenario.sentinelEffect && scenario !== selected)).toBe(
      true,
    );
    const executed: string[] = [];
    const result = await withFixturesDir((fixturesDir) =>
      runProbe(
        {
          provider,
          credentialMode: CREDENTIAL_MODE[provider],
          updateFixtures: false,
          maxScenarios: 20,
          maxWallClockSeconds: 60,
          scenarioIds: [selected.id],
        },
        {
          executablePath: `/fake/${provider}`,
          fixturesDir,
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario: stubRunScenario(provider, { executed }),
        },
      ),
    );

    expect(executed).toEqual([selected.id]);
    expect(result).toMatchObject({ passed: true, scenariosExecuted: 1 });
    expect(result.failures.filter((failure) => failure.includes('Missing live behavior evidence'))).toEqual([]);
  });

  it('passes a --max-scenarios verify run without owing evidence for the scenarios past the cap', async () => {
    // Claude Code's first scenario covers an event with a single source effect, so the capped run
    // owes exactly the evidence it records; later scenarios still carry effects of their own.
    const provider = 'claude-code';
    const [first, ...later] = getManifest(provider).scenarios;
    expect(first!.sourceExpectedEffects).toEqual([first!.sentinelEffect]);
    expect(later.some((scenario) => scenario.sentinelEffect !== undefined)).toBe(true);
    const executed: string[] = [];
    const result = await withFixturesDir((fixturesDir) =>
      runProbe(
        {
          provider,
          credentialMode: CREDENTIAL_MODE[provider],
          updateFixtures: false,
          maxScenarios: 1,
          maxWallClockSeconds: 60,
        },
        {
          executablePath: `/fake/${provider}`,
          fixturesDir,
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario: stubRunScenario(provider, { executed }),
        },
      ),
    );

    expect(executed).toEqual([first!.id]);
    expect(result).toEqual({ passed: true, scenariosExecuted: 1, failures: [] });
  });

  it('fails a --scenario verify run that misses only the selected pair', async () => {
    const provider = 'codex';
    const selected = singleEffectScenario(provider);
    const result = await withFixturesDir((fixturesDir) =>
      runProbe(
        {
          provider,
          credentialMode: CREDENTIAL_MODE[provider],
          updateFixtures: false,
          maxScenarios: 20,
          maxWallClockSeconds: 60,
          scenarioIds: [selected.id],
        },
        {
          executablePath: `/fake/${provider}`,
          fixturesDir,
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario: stubRunScenario(provider, { executed: [], observedEffects: () => [] }),
        },
      ),
    );

    expect(result.passed).toBe(false);
    expect(result.scenariosExecuted).toBe(1);
    expect(result.failures.filter((failure) => failure.includes('Missing live behavior evidence'))).toEqual([
      `Missing live behavior evidence for ${effectKey(selected)}`,
    ]);
  });

  it('refuses to publish when a full update run misses one scenario effect', async () => {
    const provider = 'codex';
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-client-publish-missing-effect-'));
    const fixturesDir = path.join(root, 'clients');
    const sourceFixturesDir = resolveDefaultFixturesDir(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-agent-clients.ts'),
    );
    const manifestRelativePath = path.join(
      provider,
      'src',
      'runtime',
      '__tests__',
      'fixtures',
      'hook-contracts',
      'manifest.json',
    );
    const manifestPath = path.join(fixturesDir, manifestRelativePath);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.copyFile(path.join(sourceFixturesDir, manifestRelativePath), manifestPath);
    const original = await fs.readFile(manifestPath, 'utf8');
    const omitted = singleEffectScenario(provider);
    const providerManifest = getManifest(provider);
    try {
      const result = await runProbe(
        {
          provider,
          credentialMode: CREDENTIAL_MODE[provider],
          updateFixtures: true,
          maxScenarios: providerManifest.scenarios.length,
          maxWallClockSeconds: 60,
        },
        {
          executablePath: `/fake/${provider}`,
          fixturesDir,
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario: stubRunScenario(provider, {
            executed: [],
            writeStaged: true,
            observedEffects: (scenario) => (scenario.id === omitted.id ? [] : undefined),
          }),
        },
      );

      expect(result).toEqual({
        passed: false,
        scenariosExecuted: providerManifest.scenarios.length,
        failures: [`Missing live behavior evidence for ${effectKey(omitted)}`],
      });
      await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(original);
      await expect(
        fs.access(fixtureFilePath({ baseDir: fixturesDir, provider, scenarioId: providerManifest.scenarios[0]!.id })),
      ).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
