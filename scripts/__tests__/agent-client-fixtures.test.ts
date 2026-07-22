import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compareFixtures,
  fixtureFilePath,
  hookContractManifestPath,
  publishProbeEvidence,
  readFixture,
  writeFixture,
} from '../lib/agent-clients/fixtures.js';
import type { ScenarioFixture } from '../lib/agent-clients/types.js';

function createFixture(overrides?: Partial<ScenarioFixture>): ScenarioFixture {
  return {
    schemaVersion: 3,
    provider: 'claude-code',
    cliVersion: '2.1.143',
    scenarioId: 'session-lifecycle',
    events: [
      {
        eventName: 'SessionStart',
        frameworkSubject: 'client.session.started',
        responseCapabilities: [],
        mode: 'event',
        candidateExpectedStatus: 'observer-only',
        observedStatus: 'observer-only',
        sourceExpectedEffects: [],
        observedEffects: [],
        blockingCapable: false,
        managedCommand: 'hook received claude-code',
        payloadKeys: [],
        sentinelInjected: false,
      },
      {
        eventName: 'Stop',
        frameworkSubject: 'client.session.turn.completed',
        responseCapabilities: [],
        mode: 'event',
        candidateExpectedStatus: 'observer-only',
        observedStatus: 'observer-only',
        sourceExpectedEffects: [],
        observedEffects: [],
        blockingCapable: false,
        managedCommand: 'hook received claude-code',
        payloadKeys: [],
        sentinelInjected: false,
      },
    ],
    oraclePassed: true,
    oracle: 'capture-only',
    exitCode: 0,
    ...overrides,
  };
}

/**
 * Captures both file bytes and directory shape for transactional rollback assertions.
 * @param root
 */
async function snapshotTree(root: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    snapshot[`${relativeDirectory}/`] = '<directory>';
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else snapshot[relativePath] = await readFile(absolutePath, 'utf8');
    }
  }
  await visit(root, '');
  return snapshot;
}

function hookContractManifest(): Record<string, unknown> {
  return {
    version: '0.2.0',
    clientId: 'claude-code',
    cliVersion: '2.1.143',
    liveProbe: { status: 'pending', capturedAt: null },
    events: {
      SessionStart: { candidateEvidenceStatus: 'observer-only', observedEvidenceStatus: null, hookFired: null },
      Stop: { candidateEvidenceStatus: 'observer-only', observedEvidenceStatus: null, hookFired: null },
    },
  };
}

describe('fixtureFilePath', () => {
  it('produces a path under provider subdirectory', () => {
    const result = fixtureFilePath({
      baseDir: '/fixtures',
      provider: 'claude-code',
      scenarioId: 'session-lifecycle',
    });

    expect(result).toBe(
      '/fixtures/claude-code/src/runtime/__tests__/fixtures/hook-contracts/probe/session-lifecycle.json',
    );
  });

  it('sanitizes scenario IDs with special characters', () => {
    const result = fixtureFilePath({
      baseDir: '/fixtures',
      provider: 'codex',
      scenarioId: 'weird/scenario:name!',
    });

    expect(result).toBe(
      '/fixtures/codex/src/runtime/__tests__/fixtures/hook-contracts/probe/weird_scenario_name_.json',
    );
  });
});

describe('writeFixture / readFixture', () => {
  it('round-trips a fixture through write and read', async () => {
    const dir = join(tmpdir(), `makaio-fixture-${randomUUID()}`);
    try {
      const fixture = createFixture();
      const filePath = await writeFixture({ baseDir: dir, fixture });

      expect(filePath).toContain('claude-code/src/runtime/__tests__/fixtures/hook-contracts/probe');
      expect(filePath).toContain('session-lifecycle.json');

      const content = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(content) as ScenarioFixture;
      expect(parsed.provider).toBe('claude-code');
      expect(parsed.cliVersion).toBe('2.1.143');
      expect(parsed.events).toHaveLength(2);

      const readBack = await readFixture(filePath);
      expect(readBack).toEqual(fixture);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('readFixture returns undefined for non-existent files', async () => {
    const result = await readFixture('/nonexistent/path/fixture.json');
    expect(result).toBeUndefined();
  });

  it('creates provider subdirectory if it does not exist', async () => {
    const dir = join(tmpdir(), `makaio-fixture-${randomUUID()}`);
    try {
      const fixture = createFixture({ provider: 'codex' });
      const filePath = await writeFixture({ baseDir: dir, fixture });
      const content = await readFile(filePath, 'utf8');
      expect(JSON.parse(content)).toHaveProperty('provider', 'codex');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('publishProbeEvidence', () => {
  it('restores every destination and removes publication directories when a mid-transaction write fails', async () => {
    const baseDir = join(tmpdir(), `makaio-probe-evidence-${randomUUID()}`);
    const stagedBaseDir = join(tmpdir(), `makaio-staged-probe-evidence-${randomUUID()}`);
    try {
      const manifestPath = hookContractManifestPath({ baseDir, provider: 'claude-code' });
      await mkdir(join(manifestPath, '..'), { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify(hookContractManifest(), null, 2)}\n`, 'utf8');
      const fixtures = [createFixture(), createFixture({ scenarioId: 'session-stop' })];
      await Promise.all(fixtures.map((fixture) => writeFixture({ baseDir: stagedBaseDir, fixture })));
      const before = await snapshotTree(baseDir);
      let writes = 0;

      await expect(
        publishProbeEvidence({
          baseDir,
          stagedBaseDir,
          provider: 'claude-code',
          fixtures,
          capturedAt: '2026-07-21T20:00:00.000Z',
          dependencies: {
            beforePublicationWrite: async () => {
              writes += 1;
              if (writes === 2) throw new Error('injected publication failure');
            },
          },
        }),
      ).rejects.toThrow('injected publication failure');

      expect(writes).toBe(2);
      expect(await snapshotTree(baseDir)).toEqual(before);
    } finally {
      await Promise.all([
        rm(baseDir, { recursive: true, force: true }),
        rm(stagedBaseDir, { recursive: true, force: true }),
      ]);
    }
  });
});

describe('compareFixtures', () => {
  it('returns empty list for identical fixtures', () => {
    const fixture = createFixture();
    const diffs = compareFixtures({ recorded: fixture, committed: fixture });
    expect(diffs).toHaveLength(0);
  });

  it('detects provider mismatch', () => {
    const recorded = createFixture({ provider: 'claude-code' });
    const committed = createFixture({ provider: 'codex' });
    const diffs = compareFixtures({ recorded, committed });
    expect(diffs.some((d) => d.includes('Provider mismatch'))).toBe(true);
  });

  it('detects CLI version changes', () => {
    const recorded = createFixture({ cliVersion: '2.2.0' });
    const committed = createFixture({ cliVersion: '2.1.143' });
    const diffs = compareFixtures({ recorded, committed });
    expect(diffs.some((d) => d.includes('CLI version changed'))).toBe(true);
  });

  it('detects event count changes', () => {
    const recorded = createFixture({ events: [] });
    const committed = createFixture();
    const diffs = compareFixtures({ recorded, committed });
    expect(diffs.some((d) => d.includes('Event count changed'))).toBe(true);
  });

  it('detects event name changes at matching indices', () => {
    const recorded = createFixture({
      events: [
        {
          eventName: 'UserPromptSubmit',
          frameworkSubject: 'client.session.started',
          responseCapabilities: [],
          mode: 'event',
          candidateExpectedStatus: 'observer-only',
          observedStatus: 'observer-only',
          sourceExpectedEffects: [],
          observedEffects: [],
          blockingCapable: false,
          managedCommand: 'hook received claude-code',
          payloadKeys: [],
          sentinelInjected: false,
        },
        {
          eventName: 'Stop',
          frameworkSubject: 'client.session.turn.completed',
          responseCapabilities: [],
          mode: 'event',
          candidateExpectedStatus: 'observer-only',
          observedStatus: 'observer-only',
          sourceExpectedEffects: [],
          observedEffects: [],
          blockingCapable: false,
          managedCommand: 'hook received claude-code',
          payloadKeys: [],
          sentinelInjected: false,
        },
      ],
    });
    const committed = createFixture();
    const diffs = compareFixtures({ recorded, committed });
    expect(diffs.some((d) => d.includes('Event[0] name'))).toBe(true);
  });

  it('detects oracle result changes', () => {
    const recorded = createFixture({ oraclePassed: false });
    const committed = createFixture({ oraclePassed: true });
    const diffs = compareFixtures({ recorded, committed });
    expect(diffs.some((d) => d.includes('Oracle result changed'))).toBe(true);
  });
});
