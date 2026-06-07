import { describe, expect, it, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { WorkflowWorkerConfig } from '@makaio/contracts';
import { loadWorkflowFromConfig } from '../workflow-loader.js';

/** Directories to clean up after each test. */
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Build a minimal {@link WorkflowWorkerConfig} for loader integration tests.
 * @param overrides - Optional config overrides.
 * @returns Valid worker config stub.
 */
function makeConfig(overrides: Partial<WorkflowWorkerConfig> = {}): WorkflowWorkerConfig {
  return {
    source: { kind: 'definition', workflowId: 'wf-loader-001' },
    executionId: 'exec-loader-001',
    workflowId: 'wf-loader-001',
    triggerPayload: {},
    inputs: {},
    scope: { type: 'global' },
    busAuth: { kind: 'none' },
    context: {
      repoPath: '/repo',
      makaioHome: '/home/.makaio',
      os: 'linux',
      arch: 'x64',
    },
    env: {},
    coordinatorSessionId: 'session-loader-001',
    cancelSubject: 'workflow.cancel.wf-loader-001',
    suspensionStrategy: 'wait-in-process',
    ...overrides,
  };
}

describe('loadWorkflowFromConfig integration', () => {
  it('loads source-backed workflow modules through the real file loader', async () => {
    const source = `
const definition = {
  id: 'wf-source-001',
  name: 'Source Workflow',
  root: { id: 'wf-source-001__root', type: 'sequence', nodes: [] },
  triggers: [],
  scope: { type: 'global' },
};

export default {
  definition,
  runtimeHandlers: new Map(),
};
`;

    const loaded = await loadWorkflowFromConfig(
      makeConfig({
        source: { kind: 'source', filename: 'source-workflow.mjs', source },
      }),
    );

    expect(loaded.definition).toEqual({
      id: 'wf-source-001',
      name: 'Source Workflow',
      root: { id: 'wf-source-001__root', type: 'sequence', nodes: [] },
      triggers: [],
      scope: { type: 'global' },
    });
    expect(loaded.runtimeHandlers).toBeInstanceOf(Map);
    expect(loaded.runtimeHandlers.size).toBe(0);
  });

  it('loads a path-sourced workflow module from a real .mjs file', async () => {
    const dir = join(tmpdir(), `wf-loader-path-${randomBytes(6).toString('hex')}`);
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    const source = `
const definition = {
  id: 'wf-path-001',
  name: 'Path Workflow',
  root: { id: 'wf-path-001__root', type: 'sequence', nodes: [
    { id: 'step1', type: 'station', prompt: 'Do step 1' },
  ] },
  triggers: [],
  scope: { type: 'global' },
};
const runtimeHandlers = new Map([['step1', (ctx) => ctx]]);
export default { definition, runtimeHandlers };
`;

    const filePath = join(dir, 'path-workflow.mjs');
    await writeFile(filePath, source, 'utf8');

    const loaded = await loadWorkflowFromConfig(
      makeConfig({
        source: { kind: 'path', path: filePath },
      }),
    );

    expect(loaded.definition.id).toBe('wf-path-001');
    expect(loaded.definition.name).toBe('Path Workflow');
    expect(loaded.runtimeHandlers).toBeInstanceOf(Map);
    expect(loaded.runtimeHandlers.size).toBe(1);
    expect(loaded.runtimeHandlers.has('step1')).toBe(true);
  });

  it('loads a source-backed workflow with runtime handlers through the real file loader', async () => {
    const source = `
const definition = {
  id: 'wf-source-002',
  name: 'Source With Handlers',
  root: { id: 'wf-source-002__root', type: 'sequence', nodes: [
    { id: 'analyze', type: 'station', prompt: 'Analyze' },
  ] },
  triggers: [],
  scope: { type: 'global' },
};
const runtimeHandlers = new Map([['analyze', (ctx) => ctx]]);
export default { definition, runtimeHandlers };
`;

    const loaded = await loadWorkflowFromConfig(
      makeConfig({
        source: { kind: 'source', filename: 'source-with-handlers.mjs', source },
      }),
    );

    expect(loaded.definition.id).toBe('wf-source-002');
    expect(loaded.runtimeHandlers).toBeInstanceOf(Map);
    expect(loaded.runtimeHandlers.size).toBe(1);
    expect(loaded.runtimeHandlers.has('analyze')).toBe(true);
  });
});
