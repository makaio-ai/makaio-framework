import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { WorkflowBlocksSubjects, type WorkflowBlockCollection } from '@makaio/contracts';
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
});
