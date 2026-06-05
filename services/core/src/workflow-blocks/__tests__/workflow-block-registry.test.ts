import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { WorkflowBlocksSchemas, WorkflowBlocksSubjects, type WorkflowBlockCollection } from '@makaio/contracts';
import { WorkflowBlockRegistry } from '../workflow-block-registry.js';

function makeBlocks(extensionName = 'alpha'): WorkflowBlockCollection {
  return {
    triggers: [
      {
        metadata: {
          name: `${extensionName}.review-posted`,
          label: 'Review Posted',
          description: 'A review was posted.',
          categories: ['review'],
        },
        configSchema: z.object({
          minSeverity: z.enum(['major', 'minor']).default('minor'),
        }),
        outputSchema: z.object({
          findingCount: z.number(),
        }),
      },
    ],
    steps: [
      {
        metadata: {
          name: `${extensionName}.fetch-findings`,
          label: 'Fetch Findings',
          description: 'Fetch findings.',
        },
        configSchema: z.object({
          includeResolved: z.boolean().default(false),
        }),
        inputSchema: z.object({
          target: z.object({ repository: z.string(), prNumber: z.number().optional() }),
        }),
        outputSchema: z.object({
          findings: z.array(z.object({ id: z.string() })),
        }),
        runs: {
          type: 'station',
          prompt: 'Fetch findings for {{ input.target.repository }}.',
          role: `${extensionName}.findings-fetcher`,
        },
      },
    ],
  };
}

describe('WorkflowBlockRegistry', () => {
  it('registers, lists, and deregisters workflow blocks through the bus', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();

    await registry.register('alpha', makeBlocks('alpha'));

    const listed = await bus.request(WorkflowBlocksSubjects.list, {});
    expect(listed.triggers.map((trigger) => trigger.metadata.name)).toEqual(['alpha.review-posted']);
    expect(listed.steps.map((step) => step.metadata.name)).toEqual(['alpha.fetch-findings']);
    expect(listed.triggers[0]?.metadata.extensionName).toBe('alpha');
    expect(listed.triggers[0]?.configSchema).toMatchObject({
      type: 'object',
      properties: {
        minSeverity: {
          default: 'minor',
          enum: ['major', 'minor'],
        },
      },
    });

    expect(listed.steps[0]?.runs).toEqual({
      type: 'station',
      prompt: 'Fetch findings for {{ input.target.repository }}.',
      role: 'alpha.findings-fetcher',
    });

    await registry.deregister('alpha');
    expect(await bus.request(WorkflowBlocksSubjects.list, {})).toEqual({ triggers: [], steps: [] });

    await registry.destroy();
  });

  it('emits changed events with mutation metadata and awaits handlers', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();
    const events: Array<{ extensionName: string; revision: number; reason: 'registered' | 'deregistered' }> = [];
    let eventHandled = false;

    bus.on(WorkflowBlocksSubjects.changed, async (ctx) => {
      await Promise.resolve();
      events.push(ctx.payload);
      eventHandled = true;
    });

    await registry.register('alpha', makeBlocks('alpha'));
    await registry.deregister('alpha');

    expect(eventHandled).toBe(true);
    expect(events).toEqual([
      { extensionName: 'alpha', revision: 1, reason: 'registered' },
      { extensionName: 'alpha', revision: 2, reason: 'deregistered' },
    ]);

    await registry.destroy();
  });

  it('rolls back registration state when changed event emission fails', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();
    const failChanged = bus.on(WorkflowBlocksSubjects.changed, () => {
      throw new Error('changed failed');
    });

    await expect(registry.register('alpha', makeBlocks('alpha'))).rejects.toThrow('changed failed');
    expect(await bus.request(WorkflowBlocksSubjects.list, {})).toEqual({ triggers: [], steps: [] });

    failChanged();
    const events: Array<{ extensionName: string; revision: number; reason: 'registered' | 'deregistered' }> = [];
    bus.on(WorkflowBlocksSubjects.changed, (ctx) => {
      events.push(ctx.payload);
    });

    await registry.register('alpha', makeBlocks('alpha'));

    expect(events).toEqual([{ extensionName: 'alpha', revision: 1, reason: 'registered' }]);

    await registry.destroy();
  });

  it('rolls back deregistration state when changed event emission fails', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();

    await registry.register('alpha', makeBlocks('alpha'));
    const failChanged = bus.on(WorkflowBlocksSubjects.changed, () => {
      throw new Error('changed failed');
    });

    await expect(registry.deregister('alpha')).rejects.toThrow('changed failed');
    const listed = await bus.request(WorkflowBlocksSubjects.list, {});
    expect(listed.triggers.map((trigger) => trigger.metadata.name)).toEqual(['alpha.review-posted']);
    expect(listed.steps.map((step) => step.metadata.name)).toEqual(['alpha.fetch-findings']);

    failChanged();
    const events: Array<{ extensionName: string; revision: number; reason: 'registered' | 'deregistered' }> = [];
    bus.on(WorkflowBlocksSubjects.changed, (ctx) => {
      events.push(ctx.payload);
    });

    await registry.deregister('alpha');

    expect(events).toEqual([{ extensionName: 'alpha', revision: 2, reason: 'deregistered' }]);

    await registry.destroy();
  });

  it('rejects duplicate block names across triggers and steps', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();
    const duplicateBlocks = makeBlocks('alpha');
    duplicateBlocks.steps![0]!.metadata.name = 'alpha.review-posted';

    await expect(Promise.resolve().then(() => registry.register('alpha', duplicateBlocks))).rejects.toThrow(
      "Workflow block name collision: 'alpha.review-posted' is already registered",
    );

    await registry.destroy();
  });

  it('rejects blocks that do not use the registering extension namespace', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();

    await expect(Promise.resolve().then(() => registry.register('alpha', makeBlocks('beta')))).rejects.toThrow(
      "Workflow block 'beta.review-posted' must be namespaced by extension 'alpha.'",
    );

    await registry.destroy();
  });

  it('rejects step run outputSchema fields that are not JSON-safe in the catalog response schema', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();
    const [step] = makeBlocks('alpha').steps ?? [];
    if (!step) throw new Error('Test fixture must include a step block');

    await registry.register('alpha', {
      steps: [
        {
          ...step,
          runs: {
            type: 'station',
            prompt: 'Fetch findings.',
            outputSchema: {
              // Date is not JSON-safe — should fail schema validation
              createdAt: new Date(0) as unknown as string,
            },
          },
        },
      ],
    });

    const parsed = WorkflowBlocksSchemas.list.response.safeParse({
      triggers: registry.listTriggers(),
      steps: registry.listSteps(),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('steps.0.runs.outputSchema.createdAt');
    }

    await registry.destroy();
  });

  it('rejects empty station prompts in the catalog response schema', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();
    const [step] = makeBlocks('alpha').steps ?? [];
    if (!step) throw new Error('Test fixture must include a step block');

    await registry.register('alpha', {
      steps: [
        {
          ...step,
          runs: {
            type: 'station',
            prompt: '',
          },
        },
      ],
    });

    const parsed = WorkflowBlocksSchemas.list.response.safeParse({
      triggers: registry.listTriggers(),
      steps: registry.listSteps(),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('steps.0.runs.prompt');
    }

    await registry.destroy();
  });

  it('rejects empty delegate-agent agentId in the catalog response schema', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();
    const [step] = makeBlocks('alpha').steps ?? [];
    if (!step) throw new Error('Test fixture must include a step block');

    await registry.register('alpha', {
      steps: [
        {
          ...step,
          runs: {
            type: 'delegate-agent',
            agentId: '',
          },
        },
      ],
    });

    const parsed = WorkflowBlocksSchemas.list.response.safeParse({
      triggers: registry.listTriggers(),
      steps: registry.listSteps(),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('steps.0.runs.agentId');
    }

    await registry.destroy();
  });

  it('returns defensive snapshots from list APIs', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();

    await registry.register('alpha', makeBlocks('alpha'));
    const listed = registry.listTriggers();
    listed[0]!.metadata.label = 'Mutated Label';
    listed[0]!.configSchema['x-mutated'] = true;

    const fresh = registry.listTriggers();
    expect(fresh[0]?.metadata.label).toBe('Review Posted');
    expect(fresh[0]?.configSchema).not.toHaveProperty('x-mutated');

    await registry.destroy();
  });

  it('serializes trigger and step schemas to JSON Schema for catalog responses', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();

    await registry.register('alpha', makeBlocks('alpha'));

    const listed = await bus.request(WorkflowBlocksSubjects.list, {});
    expect(listed.triggers[0]?.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        findingCount: { type: 'number' },
      },
    });
    expect(listed.steps[0]?.configSchema).toMatchObject({
      type: 'object',
      properties: {
        includeResolved: {
          default: false,
          type: 'boolean',
        },
      },
    });
    expect(listed.steps[0]?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: {
            repository: { type: 'string' },
          },
        },
      },
    });
    expect(listed.steps[0]?.outputSchema).toMatchObject({
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
            },
          },
        },
      },
    });

    await registry.destroy();
  });

  it('accepts station, delegate-agent, and delegate-role run mapping variants', async () => {
    const bus = createBusInstance();
    const registry = new WorkflowBlockRegistry(bus);
    await registry.init();
    const [step] = makeBlocks('alpha').steps ?? [];
    if (!step) throw new Error('Test fixture must include a step block');

    await registry.register('alpha', {
      steps: [
        {
          ...step,
          metadata: { ...step.metadata, name: 'alpha.step-station' },
          runs: { type: 'station', prompt: 'Do work.' },
        },
        {
          ...step,
          metadata: { ...step.metadata, name: 'alpha.step-agent' },
          runs: { type: 'delegate-agent', agentId: 'my-agent' },
        },
        {
          ...step,
          metadata: { ...step.metadata, name: 'alpha.step-role' },
          runs: { type: 'delegate-role', role: 'reviewer', prompt: 'Review this.' },
        },
      ],
    });

    const listed = await bus.request(WorkflowBlocksSubjects.list, {});
    expect(listed.steps.map((s) => s.runs.type)).toEqual(['station', 'delegate-agent', 'delegate-role']);

    const parsed = WorkflowBlocksSchemas.list.response.safeParse({
      triggers: registry.listTriggers(),
      steps: registry.listSteps(),
    });
    expect(parsed.success).toBe(true);

    await registry.destroy();
  });
});
