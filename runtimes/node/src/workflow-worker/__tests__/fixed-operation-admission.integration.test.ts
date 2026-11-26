import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowAgentStepNodeSchema, WorkflowSubjects, type WorkflowDefinition } from '@makaio/contracts';
import type { FixedOperationContribution } from '@makaio/contracts/extension';
import { expect, it } from 'vitest';
import { composeFixedOperationHost, makeFixedOperationExtension, runPorts } from './fixed-operation-host.fixture.js';
import { makeWorkerConfig } from './fixtures.js';

const owner = 'required-tools';
const laterOwner = 'later-tools';

/**
 * Compose a source-free run and record any contribution invoked by the actual host.
 * @param workspace - Parent of the private run directory.
 * @param nodes - Workflow steps to execute after preparation.
 * @returns The coordinator, run options, and externally observed operations.
 */
function prepareRun(workspace: string, nodes: WorkflowDefinition['root']['nodes']) {
  const operations: string[] = [];
  const contribution = (extension: string): FixedOperationContribution => ({
    name: `${extension}.prepare`,
    phase: 'before-steps',
    applies: () => true,
    async run() {
      operations.push(extension);
      return { ok: true, facts: { prepared: true } };
    },
  });
  const required = contribution(owner);
  const later = contribution(laterOwner);
  const fixture = composeFixedOperationHost(
    [makeFixedOperationExtension(owner, [required]), makeFixedOperationExtension(laterOwner, [later])],
    workspace,
  );
  const { bus } = fixture;
  const options = {
    bus,
    call: bus.own('root'),
    workspace,
    signal: new AbortController().signal,
    config: {
      ...makeWorkerConfig({
        definition: {
          id: 'workflow-1',
          scope: { type: 'global' },
          extensions: { [owner]: true, [laterOwner]: true },
          root: { id: 'root', type: 'sequence', nodes },
        },
      }),
      terminalAuthority: 'authority' as const,
    },
  };
  return { ...fixture, options, operations, required, later };
}

it.each(['withdrawn', 'reactivated'])('rejects an admission when its required registration is %s', async (mode) => {
  const workspace = await mkdtemp(join(tmpdir(), 'fixed-operation-admission-'));
  const { host, bus, coordinator, close, options, operations, required } = prepareRun(workspace, [
    WorkflowAgentStepNodeSchema.parse({ id: 'step', type: 'agent-step', role: 'reviewer', prompt: 'Review' }),
  ]);
  const frames: string[] = [];
  const offFrame = bus.on(WorkflowSubjects.frame.started, (ctx) => {
    frames.push(ctx.payload.nodeId);
  });
  try {
    await coordinator.startAll();
    const { entries, admission } = host.catalog();
    expect(entries[required.name]).toEqual({ extension: owner, phase: 'before-steps' });
    await expect(coordinator.applyExtensionTransition(owner, false)).resolves.toBe('applied');
    if (mode === 'reactivated') {
      await expect(coordinator.applyExtensionTransition(owner, true)).resolves.toBe('applied');
      expect(host.catalog().entries).toEqual(entries);
    }
    await expect(host.run(options, { ...runPorts, allowSourceFree: true, admission })).rejects.toMatchObject({
      code: 'inactive-registration',
      phase: 'before-steps',
    });
    expect(operations).toEqual([]);
    expect(frames).toEqual([]);
    await expect(readdir(workspace)).resolves.toEqual([]);
  } finally {
    offFrame();
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});

it.each(['unchanged', 'extended'])('runs exactly the admitted operations with the catalog %s', async (mode) => {
  const workspace = await mkdtemp(join(tmpdir(), 'fixed-operation-admission-'));
  const { host, coordinator, close, options, operations, required, later } = prepareRun(workspace, []);
  try {
    await coordinator.startAll();
    await expect(coordinator.applyExtensionTransition(laterOwner, false)).resolves.toBe('applied');
    const { entries, admission } = host.catalog();
    expect(entries).toEqual({ [required.name]: { extension: owner, phase: 'before-steps' } });
    if (mode === 'extended') {
      await expect(coordinator.applyExtensionTransition(laterOwner, true)).resolves.toBe('applied');
      expect(host.catalog().entries[later.name]).toBeDefined();
    }
    const ports = { ...runPorts, allowSourceFree: true, admission } as const;
    const outcome = await host.run(options, ports);
    expect(outcome.result.status).toBe('completed');
    expect(outcome.facts).toEqual(new Map([[owner, { prepared: true }]]));
    await expect(host.run(options, ports)).rejects.toMatchObject({
      code: 'inactive-registration',
      phase: 'registration',
    });
    expect(operations).toEqual([owner]);
  } finally {
    await close();
    await rm(workspace, { recursive: true, force: true });
  }
});
