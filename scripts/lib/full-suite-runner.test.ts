/**
 * Contract tests for the shared full-suite orchestration.
 *
 * Uses a small synthetic project table; workspace runners only contribute
 * their own tables and child-process execution on top of this contract.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFullSuitePlan,
  buildProjectBatches,
  heapNodeOptions,
  resolvePlanMode,
  runFullSuite,
  type FullSuitePlanConfig,
} from './full-suite-runner.js';

const CONFIG: FullSuitePlanConfig = {
  broadProjects: ['alpha', 'beta', 'gamma'],
  broadBatchSize: 2,
  specialProjects: ['serial-a', 'serial-b'],
  declaredSpecialProjects: ['serial-a', 'serial-b'],
  bunBatchName: 'bun',
};

describe('buildProjectBatches', () => {
  it('partitions ordered projects into bounded batches', () => {
    expect(buildProjectBatches(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });

  it('rejects non-positive batch sizes', () => {
    expect(() => buildProjectBatches(['a'], 0)).toThrow('positive integer');
  });
});

describe('resolvePlanMode', () => {
  it('gates the automatic choice on machine memory with an env override', () => {
    const gib = 1024 ** 3;
    expect(resolvePlanMode({}, 128 * gib)).toBe('single');
    expect(resolvePlanMode({}, 16 * gib)).toBe('bounded');
    expect(resolvePlanMode({ MAKAIO_TEST_PLAN: 'bounded' }, 128 * gib)).toBe('bounded');
    expect(resolvePlanMode({ MAKAIO_TEST_PLAN: 'single' }, 16 * gib)).toBe('single');
  });
});

describe('buildFullSuitePlan', () => {
  it('builds bounded batches, isolated specials, then the Bun surface', () => {
    expect(buildFullSuitePlan(CONFIG, 'bounded')).toEqual([
      ['alpha', 'beta'],
      ['gamma'],
      ['serial-a'],
      ['serial-b'],
      ['bun'],
    ]);
  });

  it('collapses the single plan into one all-project batch plus the Bun surface', () => {
    expect(buildFullSuitePlan(CONFIG, 'single')).toEqual([['alpha', 'beta', 'gamma', 'serial-a', 'serial-b'], ['bun']]);
  });

  it('omits the Bun surface when the workspace declares none', () => {
    const plan = buildFullSuitePlan({ ...CONFIG, bunBatchName: undefined }, 'single');
    expect(plan).toEqual([['alpha', 'beta', 'gamma', 'serial-a', 'serial-b']]);
  });

  it('refuses to run when scheduled specials drift from the declared set', () => {
    expect(() => buildFullSuitePlan({ ...CONFIG, declaredSpecialProjects: ['serial-a'] }, 'bounded')).toThrow(
      'must match',
    );
  });
});

describe('runFullSuite', () => {
  it('continues after failures and returns a nonzero status', async () => {
    const visited: string[] = [];
    const failures: string[] = [];
    const logs: string[] = [];

    const status = await runFullSuite({
      config: CONFIG,
      planMode: 'bounded',
      executeBatch: async (projects) => {
        visited.push(projects.join(', '));
        if (projects[0] === 'gamma') throw new Error('intentional failure');
      },
      now: () => 100,
      log: (message) => logs.push(message),
      reportFailure: (message) => failures.push(message),
    });

    expect(visited).toEqual(['alpha, beta', 'gamma', 'serial-a', 'serial-b', 'bun']);
    expect(status).toBe(1);
    expect(failures).toEqual(['Test project batches failed: gamma']);
    // Spawn- and lock-level failures produce no child output, so the batch
    // error itself has to reach the log or the failure is undiagnosable.
    expect(logs).toContain('Test project batch gamma errored: intentional failure');
  });

  it('gives only the single-plan all-project batch a heap ceiling and worker budget', async () => {
    const contextByLabel = new Map<string, { heapMb?: number; maxWorkers?: number }>();

    const status = await runFullSuite({
      config: CONFIG,
      planMode: 'single',
      executeBatch: async (projects, context) => {
        contextByLabel.set(projects.join(', '), context);
      },
      now: () => 100,
      log: () => {},
      reportFailure: () => {},
    });

    expect(status).toBe(0);
    const allProjects = contextByLabel.get('alpha, beta, gamma, serial-a, serial-b');
    expect(allProjects?.heapMb).toBeGreaterThan(0);
    expect(allProjects?.maxWorkers).toBeGreaterThan(4);
    expect(contextByLabel.get('bun')).toEqual({});
  });

  it('runs every batch inside its machine slot and labels the all-project batch', async () => {
    const events: string[] = [];

    const status = await runFullSuite({
      config: CONFIG,
      planMode: 'single',
      executeBatch: async (projects) => {
        events.push(`run ${projects.length}`);
      },
      now: () => 100,
      log: () => {},
      reportFailure: () => {},
      acquireBatchSlot: async (label, run) => {
        events.push(`acquire ${label}`);
        try {
          return await run();
        } finally {
          events.push(`release ${label}`);
        }
      },
    });

    expect(status).toBe(0);
    expect(events).toEqual([
      'acquire all projects',
      'run 5',
      'release all projects',
      'acquire bun',
      'run 1',
      'release bun',
    ]);
  });
});

describe('heapNodeOptions', () => {
  it('composes the ceiling with existing NODE_OPTIONS and skips uncapped batches', () => {
    expect(heapNodeOptions({ heapMb: 1024 }, undefined)).toBe('--max-old-space-size=1024');
    expect(heapNodeOptions({ heapMb: 1024 }, '--inspect')).toBe('--inspect --max-old-space-size=1024');
    expect(heapNodeOptions({}, '--inspect')).toBeUndefined();
  });
});
