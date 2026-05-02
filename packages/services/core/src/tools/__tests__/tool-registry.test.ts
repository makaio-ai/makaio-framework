import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../tool-registry.js';
import { defineToolset, defineTool, toolSuccess } from '@makaio/tools-core';
import { createBusInstance } from '@makaio/bus-core';
import type { IMakaioBus } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';

describe('ToolRegistry.listToolsWithToolsets', () => {
  let registry: ToolRegistry;
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
    registry = new ToolRegistry({ bus });
  });

  afterEach(() => {
    registry.dispose();
  });

  it('should include toolset metadata with configSchema in tool.list response', async () => {
    const configSchema = z.object({
      timeout: z.number().default(30000).describe('Timeout in milliseconds'),
      maxRetries: z.number().default(3).describe('Maximum retry attempts'),
    });

    const echoTool = defineTool({
      name: 'echo',
      description: 'Echoes input back',
      inputSchema: z.object({ message: z.string() }),
      outputSchema: z.object({ echo: z.string() }),
      execute: async (input) => toolSuccess({ echo: input.message }),
    });

    const toolset = defineToolset({
      name: 'test',
      description: 'Test toolset',
      version: '1.0.0',
      tools: [echoTool],
      configSchema,
    });

    await registry.register(toolset);

    const result = await registry.listToolsWithToolsets();

    // Verify toolsets array
    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0].name).toBe('test');
    expect(result.toolsets[0].description).toBe('Test toolset');
    expect(result.toolsets[0].version).toBe('1.0.0');
    expect(result.toolsets[0].toolCount).toBe(1);

    // Verify configSchema is converted to JSON Schema format
    expect(result.toolsets[0].configSchema).toBeDefined();
    expect(result.toolsets[0].configSchema?.type).toBe('object');
    expect(result.toolsets[0].configSchema?.properties).toBeDefined();

    // Verify tools array is still present
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('echo');
  });

  it('should return toolsets without configSchema when not defined', async () => {
    const noopTool = defineTool({
      name: 'noop',
      description: 'Does nothing',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => toolSuccess({}),
    });

    const toolset = defineToolset({
      name: 'minimal',
      description: 'Minimal toolset',
      version: '1.0.0',
      tools: [noopTool],
      // No configSchema
    });

    await registry.register(toolset);

    const result = await registry.listToolsWithToolsets();

    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0].name).toBe('minimal');
    expect(result.toolsets[0].configSchema).toBeUndefined();
  });

  it('should filter toolsets by name when filter is provided', async () => {
    const tool1 = defineTool({
      name: 'tool1',
      description: 'Tool 1',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => toolSuccess({}),
    });

    const tool2 = defineTool({
      name: 'tool2',
      description: 'Tool 2',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => toolSuccess({}),
    });

    await registry.register(
      defineToolset({
        name: 'toolset-a',
        description: 'Toolset A',
        version: '1.0.0',
        tools: [tool1],
      }),
    );

    await registry.register(
      defineToolset({
        name: 'toolset-b',
        description: 'Toolset B',
        version: '2.0.0',
        tools: [tool2],
      }),
    );

    const result = await registry.listToolsWithToolsets({ toolsetName: 'toolset-a' });

    expect(result.toolsets).toHaveLength(1);
    expect(result.toolsets[0].name).toBe('toolset-a');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('tool1');
  });
});

describe('ToolRegistry.listToolsets', () => {
  let registry: ToolRegistry;
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
    registry = new ToolRegistry({ bus });
  });

  afterEach(() => {
    registry.dispose();
  });

  it('should list all registered toolsets', async () => {
    const tool = defineTool({
      name: 'sample',
      description: 'Sample tool',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => toolSuccess({}),
    });

    await registry.register(
      defineToolset({
        name: 'fs',
        description: 'Filesystem tools',
        version: '1.0.0',
        tools: [tool],
      }),
    );

    const toolsets = registry.listToolsets();

    expect(toolsets).toHaveLength(1);
    expect(toolsets[0]).toEqual({
      name: 'fs',
      description: 'Filesystem tools',
      version: '1.0.0',
      toolCount: 1,
    });
  });
});

describe('ToolRegistry.deregister', () => {
  let registry: ToolRegistry;

  // Use an isolated bus to avoid handler conflicts with the global MakaioBus singleton.
  beforeEach(() => {
    registry = new ToolRegistry({ bus: createBusInstance() });
  });

  afterEach(() => {
    registry.dispose();
  });

  it('deregister registered toolset → subsequent listTools() is empty', async () => {
    const tool = defineTool({
      name: 'myTool',
      description: 'My tool',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => toolSuccess({}),
    });

    await registry.register(
      defineToolset({
        name: 'my-toolset',
        description: 'My toolset',
        version: '1.0.0',
        tools: [tool],
      }),
    );

    expect(registry.listTools()).toHaveLength(1);

    await registry.deregister('my-toolset');

    expect(registry.listTools()).toHaveLength(0);
  });

  it('deregister unknown toolset throws with name in message', async () => {
    await expect(registry.deregister('non-existent')).rejects.toThrow('non-existent');
  });

  it('tools cleaned up: register toolset with 2 tools, deregister → getTool returns undefined for both', async () => {
    const toolA = defineTool({
      name: 'toolA',
      description: 'Tool A',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => toolSuccess({}),
    });
    const toolB = defineTool({
      name: 'toolB',
      description: 'Tool B',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      execute: async () => toolSuccess({}),
    });

    await registry.register(
      defineToolset({
        name: 'two-tool-set',
        description: 'Two tool toolset',
        version: '1.0.0',
        tools: [toolA, toolB],
      }),
    );

    expect(registry.getTool('toolA')).toBeDefined();
    expect(registry.getTool('toolB')).toBeDefined();

    await registry.deregister('two-tool-set');

    expect(registry.getTool('toolA')).toBeUndefined();
    expect(registry.getTool('toolB')).toBeUndefined();
  });

  describe('registryChanged events', () => {
    let bus: IMakaioBus;
    let reg: ToolRegistry;

    beforeEach(() => {
      bus = createBusInstance();
      reg = new ToolRegistry({ bus });
    });

    afterEach(() => {
      reg.dispose();
    });

    it('registryChanged emitted with reason toolset-unregistered and correct revision', async () => {
      const tool = defineTool({
        name: 'eventTool',
        description: 'Event tool',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        execute: async () => toolSuccess({}),
      });

      await reg.register(
        defineToolset({
          name: 'event-toolset',
          description: 'Event toolset',
          version: '1.0.0',
          tools: [tool],
        }),
      );

      const events: Array<{ reason: string; toolsetName: string; revision: number }> = [];
      bus.on(ToolSubjects.registryChanged, (ctx) => {
        events.push({
          reason: ctx.payload.reason,
          toolsetName: ctx.payload.toolsetName,
          revision: ctx.payload.revision,
        });
      });

      await reg.deregister('event-toolset');

      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe('toolset-unregistered');
      expect(events[0].toolsetName).toBe('event-toolset');
      expect(events[0].revision).toBeGreaterThan(0);
    });

    it('registryChanged emitted on register with reason toolset-registered and revision increments monotonically', async () => {
      const revisions: number[] = [];
      bus.on(ToolSubjects.registryChanged, (ctx) => {
        revisions.push(ctx.payload.revision);
      });

      const toolA = defineTool({
        name: 'monoToolA',
        description: 'Mono tool A',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        execute: async () => toolSuccess({}),
      });
      const toolB = defineTool({
        name: 'monoToolB',
        description: 'Mono tool B',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        execute: async () => toolSuccess({}),
      });

      await reg.register(
        defineToolset({
          name: 'mono-toolset-a',
          description: 'Mono toolset A',
          version: '1.0.0',
          tools: [toolA],
        }),
      );

      await reg.register(
        defineToolset({
          name: 'mono-toolset-b',
          description: 'Mono toolset B',
          version: '1.0.0',
          tools: [toolB],
        }),
      );

      await reg.deregister('mono-toolset-a');

      // Revisions should be monotonically increasing: 1, 2, 3
      expect(revisions).toHaveLength(3);
      expect(revisions[0]).toBe(1);
      expect(revisions[1]).toBe(2);
      expect(revisions[2]).toBe(3);
    });
  });
});
