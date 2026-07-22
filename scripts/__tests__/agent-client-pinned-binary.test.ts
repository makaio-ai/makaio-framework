import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getPinnedVersion, getVersionCommand } from '../lib/agent-clients/manifests.js';
import { preparePinnedProbeBinary, resolveManagedExecutable } from '../lib/agent-clients/pinned-binary.js';
import type { runScenario as runAgentClientScenario, ScenarioRunResult } from '../lib/agent-clients/runner.js';
import type { StrategyDependencies } from '@makaio/subsystem-client';
import { runProbe } from '../test-agent-clients.js';
import type { validateBinaryVersion } from '../lib/agent-clients/version-validation.js';

function strategyDependencies(overrides: Partial<StrategyDependencies> = {}): StrategyDependencies {
  return {
    fetchText: async () => '',
    fetchJson: async () => ({}),
    downloadFile: async (_url, destination) => destination,
    exec: async () => '',
    extractArchive: async () => undefined,
    deleteFile: async () => undefined,
    computeChecksum: async () => '',
    removeDirectory: async (directory) => fs.rm(directory, { recursive: true, force: true }),
    ...overrides,
  };
}

describe('pinned agent-client binary preparation', () => {
  it.each([
    ['claude-code', 'claude'],
    ['codex', 'node_modules/.bin/codex'],
  ] as const)('resolves the %s version command relative to its managed artifact', (provider, relativeExecutable) => {
    expect(resolveManagedExecutable('/managed/artifact', getVersionCommand(provider).executable)).toBe(
      path.join('/managed/artifact', relativeExecutable),
    );
  });

  it('executes the existing Codex managed-install descriptor at its exact pin and removes the disposable directory', async () => {
    let installDirectory: string | undefined;
    const exec = vi.fn(async (_command: string, args: string[]) => {
      installDirectory = args[args.indexOf('--prefix') + 1];
      return '';
    });
    const removeDirectory = vi.fn(async (directory: string) => fs.rm(directory, { recursive: true, force: true }));
    const binary = await preparePinnedProbeBinary({
      provider: 'codex',
      strategyDependencies: strategyDependencies({ exec, removeDirectory }),
    });

    expect(exec).toHaveBeenCalledWith('npm', [
      'install',
      `@openai/codex@${getPinnedVersion('codex')}`,
      '--prefix',
      installDirectory!,
      '--no-save',
      '--ignore-scripts',
    ]);
    expect(binary.executablePath).toBe(path.join(installDirectory!, 'node_modules/.bin/codex'));
    await binary.cleanup();
    expect(removeDirectory).toHaveBeenCalledWith(installDirectory);
    await expect(fs.access(installDirectory!)).rejects.toThrow();
  });

  it('does not use an ambient mismatching global executable when no test override is supplied', async () => {
    const cleanup = vi.fn(async () => undefined);
    const validate = vi.fn<typeof validateBinaryVersion>(async (params) => ({
      valid: typeof params.executable === 'string' && params.executable === '/disposable/codex',
      pinnedVersion: params.pinnedVersion,
    }));
    const runScenario = vi.fn<typeof runAgentClientScenario>(
      async (_params): Promise<ScenarioRunResult & { readonly fixtureDiffs: readonly string[] }> => ({
        fixture: {
          schemaVersion: 3 as const,
          provider: 'codex' as const,
          cliVersion: getPinnedVersion('codex'),
          scenarioId: 'fake',
          events: [],
          oracle: 'unobserved' as const,
          oraclePassed: true,
          exitCode: 0,
        },
        stdout: '',
        stderr: '',
        timedOut: false,
        fixtureDiffs: [],
      }),
    );

    await runProbe(
      {
        provider: 'codex',
        credentialMode: 'access-token',
        updateFixtures: false,
        maxScenarios: 1,
        maxWallClockSeconds: 1,
      },
      {
        preparePinnedBinary: async () => ({ executablePath: '/disposable/codex', cleanup }),
        validateBinaryVersion: validate,
        runScenario,
      },
    );

    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ executable: '/disposable/codex' }));
    expect(runScenario).toHaveBeenCalledWith(expect.objectContaining({ executablePath: '/disposable/codex' }));
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('cleans the prepared binary after a scenario failure', async () => {
    const cleanup = vi.fn(async () => undefined);
    await expect(
      runProbe(
        {
          provider: 'codex',
          credentialMode: 'access-token',
          updateFixtures: false,
          maxScenarios: 1,
          maxWallClockSeconds: 1,
        },
        {
          preparePinnedBinary: async () => ({ executablePath: '/disposable/codex', cleanup }),
          validateBinaryVersion: async ({ pinnedVersion }) => ({ valid: true, pinnedVersion }),
          runScenario: async () => {
            throw new Error('scenario failed');
          },
        },
      ),
    ).rejects.toThrow('scenario failed');
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
